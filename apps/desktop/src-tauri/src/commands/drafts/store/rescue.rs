//! Text-only projection of human input from a single journal snapshot.
use super::*;
use std::io::{self, BufWriter};
use std::time::{SystemTime, UNIX_EPOCH};
use tsumugi_core::ProjectMetadata;

fn write_error(_: io::Error) -> ExecutionError {
    fail(ErrorCode::StorageFailed, "draft-rescue-write")
}

impl DraftStore {
    pub(in crate::commands) fn rescue_to(
        &self,
        metadata: &ProjectMetadata,
        destination: &Path,
    ) -> Result<()> {
        let directory = destination
            .parent()
            .ok_or_else(|| fail(ErrorCode::InvalidInput, "draft-rescue-destination"))?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".draft-rescue-")
            .tempfile_in(directory)
            .map_err(write_error)?;
        {
            let mut output = BufWriter::new(temporary.as_file_mut());
            self.write_rescue(metadata, &mut output)?;
            output.flush().map_err(write_error)?;
        }
        temporary.as_file().sync_all().map_err(write_error)?;
        temporary.persist_noclobber(destination).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                fail(ErrorCode::DependencyConflict, "draft-rescue-destination")
            } else {
                write_error(error.error)
            }
        })?;
        #[cfg(unix)]
        fs::File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| fail(ErrorCode::OutcomeUnknown, "draft-rescue-publish"))?;
        Ok(())
    }

    fn write_rescue(&self, metadata: &ProjectMetadata, output: &mut impl Write) -> Result<()> {
        let project = ExecutionId::parse(&metadata.project_id().to_string())?;
        let captured = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| fail(ErrorCode::StorageFailed, "draft-rescue-clock"))?;
        writeln!(output, "Tsumugi draft rescue\nProject: {} ({project})\nProject metadata revision: {}\nRead time (Unix seconds, UTC): {}\n",
            metadata.display_name(), metadata.metadata_revision(), captured.as_secs()).map_err(write_error)?;
        writeln!(output, "Scope: translation text, conversation messages and team text, knowledge and context edits, and source decision reasons.\n            Structured selections appear only as identifiers, labels or counts.\n            Excluded: strategy drafts, structured proposal entries and settings, connection settings, captured files, and original pending requests.\n            Check pending requests on the original device. Reapply rescued text manually.\n").map_err(write_error)?;
        let Some(mut connection) = self.existing(false)? else {
            return writeln!(output, "No local journal exists for this instance.")
                .map_err(write_error);
        };
        let snapshot = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&snapshot)?;
        writeln!(output, "Journal format: {format}").map_err(write_error)?;

        let mut translation = snapshot.prepare("SELECT locale,unit_id FROM draft_heads WHERE project_id=?1 AND edit_seq IS NOT NULL ORDER BY locale,unit_id").map_err(sql)?;
        let mut rows = translation.query([project.to_string()]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            let key = DraftKey {
                project_id: project,
                locale: row.get(0).map_err(sql)?,
                unit_id: stored_id(&row.get::<_, String>(1).map_err(sql)?)?,
            };
            let head = read_head(&snapshot, &key, format)?;
            if let Some(value) = head.value {
                writeln!(
                    output,
                    "\nTranslation / {} / entry {} / draft {} / edit {} / source revision {}",
                    key.locale,
                    key.unit_id,
                    head.revision.get(),
                    value.edit_seq.get(),
                    value.basis.source_revision_id
                )
                .map_err(write_error)?;
                text(output, "Translation", &value.text)?;
            }
        }
        if format >= CONVERSATION_FORMAT {
            let mut conversations = snapshot.prepare("SELECT conversation_id FROM conversation_draft_heads WHERE project_id=?1 AND edit_seq IS NOT NULL ORDER BY conversation_id").map_err(sql)?;
            let mut rows = conversations.query([project.to_string()]).map_err(sql)?;
            while let Some(row) = rows.next().map_err(sql)? {
                let key = ConversationDraftKey {
                    project_id: project,
                    conversation_id: stored_id(&row.get::<_, String>(0).map_err(sql)?)?,
                };
                let head = conversations::read_head(&snapshot, &key, format)?;
                if let Some(value) = head.value {
                    writeln!(
                        output,
                        "\nConversation {} / draft {} / edit {}",
                        key.conversation_id,
                        head.revision.get(),
                        value.edit_seq.get()
                    )
                    .map_err(write_error)?;
                    text(output, "Message", &value.text)?;
                    use tsumugi_core::ai::conversation_planning::ConversationPlanningModelOutput as Proposal;
                    for draft in value.proposal_edits {
                        writeln!(
                            output,
                            "Proposal {} / revision {} / edit {}",
                            draft.proposal_id,
                            draft.expected_revision_id,
                            draft.edit_seq.get()
                        )
                        .map_err(write_error)?;
                        let (summary, questions) = match &draft.content {
                            Proposal::Reply { summary, questions }
                            | Proposal::Proposal {
                                summary, questions, ..
                            }
                            | Proposal::KnowledgeProposal {
                                summary, questions, ..
                            }
                            | Proposal::TermProposal {
                                summary, questions, ..
                            }
                            | Proposal::Revision {
                                summary, questions, ..
                            } => (summary, questions),
                        };
                        text(output, "Summary", summary)?;
                        for question in questions {
                            text(output, "Question", question)?;
                        }
                        if let Proposal::Revision { text: revision, .. } = &draft.content {
                            text(output, "Revision", revision)?;
                        }
                    }
                    for plan in value.team_drafts {
                        writeln!(output, "Team plan {}", plan.plan_id).map_err(write_error)?;
                        if let Some(guidance) = plan.guidance {
                            text(output, "Guidance", &guidance.body)?;
                        }
                        if let Some(publication) = plan.publication {
                            text(output, "Discussion", &publication.body)?;
                        }
                        for question in plan.questions {
                            text(output, "Answer", &question.body)?;
                            text(output, "Dismiss reason", &question.dismiss_reason)?;
                        }
                        if let Some(recovery) = plan.recovery {
                            text(output, "Recovery instructions", &recovery.instructions)?;
                            for member in recovery.members {
                                text(output, "Member name", &member.display_name)?;
                                text(output, "Member role", &member.role)?;
                            }
                        }
                    }
                }
            }
        }
        let resource = resources::read(
            &snapshot,
            &ResourceDraftKey {
                project_id: project,
            },
            format,
        )?;
        if let Some(value) = resource.value {
            writeln!(
                output,
                "\nKnowledge and context / {} / draft {} / edit {}",
                value.locale,
                resource.revision.get(),
                value.edit_seq.get()
            )
            .map_err(write_error)?;
            text(output, "Term source", &value.term_draft.source)?;
            text(output, "Term target", &value.term_draft.target)?;
            text(output, "Alias input", &value.alias_input)?;
            text(output, "Term reason", &value.term_draft.reason)?;
            text(output, "Context", &value.context_draft)?;
            text(output, "Context reason", &value.context_reason)?;
            if let Some(correction) = value.correction_draft {
                text(output, "Correction source", &correction.source)?;
                text(output, "Correction target", &correction.target)?;
                text(output, "Correction reason", &correction.reason)?;
            }
            if let Some(fact) = value.fact_draft {
                text(output, "Source fact reason", &fact.reason)?;
            }
            for draft in value.typed_drafts {
                writeln!(
                    output,
                    "Context resource / {} / edit {}",
                    draft.locale,
                    draft.edit_seq.get()
                )
                .map_err(write_error)?;
                text(output, "Name", &draft.name)?;
                text(output, "Context", &draft.text)?;
                text(output, "Reason", &draft.reason)?;
            }
            for draft in value.knowledge_drafts {
                writeln!(
                    output,
                    "Knowledge entry {} / {} / edit {}",
                    draft.entry_index,
                    draft.locale,
                    draft.edit_seq.get()
                )
                .map_err(write_error)?;
                text(output, "Name", &draft.name)?;
                text(output, "Knowledge text", &draft.text)?;
                text(output, "Reason", &draft.reason)?;
            }
            if let Some(draft) = value.proposal_edit_draft {
                writeln!(
                    output,
                    "Term proposal entry {} / {} / edit {}",
                    draft.entry_id,
                    draft.locale,
                    draft.edit_seq.get()
                )
                .map_err(write_error)?;
                text(output, "Term target", &draft.target)?;
            }
        }
        let source = sources::read(
            &snapshot,
            &SourceDraftKey {
                project_id: project,
            },
            format,
        )?;
        if let Some(value) = source.value {
            writeln!(
                output,
                "\nSource maintenance / {} / draft {} / edit {}",
                value.source_language,
                source.revision.get(),
                value.edit_seq.get()
            )
            .map_err(write_error)?;
            for choice in value.lineage {
                writeln!(
                    output,
                    "Entry {} / previous occurrence {} / choice {:?}",
                    choice.new_ordinal, choice.old_occurrence_id, choice.decision
                )
                .map_err(write_error)?;
                text(output, "Mapping reason", &choice.reason)?;
            }
            if let Some(correction) = value.correction {
                writeln!(
                    output,
                    "Source snapshot {} / entry {}",
                    correction.snapshot_id, correction.ordinal
                )
                .map_err(write_error)?;
                text(output, "Correction reason", &correction.reason)?;
            }
        }
        Ok(())
    }
}

fn text(output: &mut impl Write, label: &str, value: &str) -> Result<()> {
    // Length leaves empty strings and embedded newlines unambiguous.
    writeln!(output, "{label} ({} UTF-8 bytes):\n{value}\n", value.len()).map_err(write_error)
}
