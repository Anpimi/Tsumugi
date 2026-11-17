use super::*;

#[derive(Clone)]
struct OriginRow {
    snapshot: ExecutionId,
    version: Revision,
    binding: SourceLineageBinding,
    evidence: bool,
}

/// One read transaction's compact bindings. Sharing this lookup across a work
/// set keeps ancestry reads per snapshot/version, rather than per occurrence.
pub(in crate::persistence) struct OriginRead<'a> {
    connection: &'a Connection,
    corrections: bool,
    captured_bases: bool,
    locations: BTreeMap<ExecutionId, ExecutionId>,
    rows: BTreeMap<(ExecutionId, u64), BTreeMap<ExecutionId, OriginRow>>,
    versions: BTreeMap<ExecutionId, Revision>,
    bases: BTreeMap<ExecutionId, BTreeMap<ExecutionId, Revision>>,
}

impl<'a> OriginRead<'a> {
    pub(in crate::persistence) fn new(connection: &'a Connection) -> Result<Self, ExecutionError> {
        let (corrections, captured_bases) = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_lineage_corrections'),
                    EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_snapshot_mapping_bases')",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(sql_error)?;
        Ok(Self {
            connection,
            corrections,
            captured_bases,
            locations: BTreeMap::new(),
            rows: BTreeMap::new(),
            versions: BTreeMap::new(),
            bases: BTreeMap::new(),
        })
    }

    fn snapshot(&mut self, occurrence: ExecutionId) -> Result<ExecutionId, ExecutionError> {
        if let Some(snapshot) = self.locations.get(&occurrence) {
            return Ok(*snapshot);
        }
        let snapshot: String = self
            .connection
            .query_row(
                "SELECT snapshot_id FROM source_occurrences WHERE occurrence_id=?1",
                [occurrence.to_string()],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        let snapshot = id(snapshot)?;
        self.locations.insert(occurrence, snapshot);
        Ok(snapshot)
    }

    fn row(&mut self, occurrence: ExecutionId, cap: Revision) -> Result<OriginRow, ExecutionError> {
        let snapshot = self.snapshot(occurrence)?;
        let key = (snapshot, cap.get());
        if !self.rows.contains_key(&key) {
            let rows: BTreeMap<_, _> = self.rows_at(snapshot, cap)?.into_iter()
                .map(|row| (row.binding.occurrence_id, row))
                .collect();
            self.locations
                .extend(rows.keys().map(|occurrence| (*occurrence, snapshot)));
            self.rows.insert(key, rows);
        }
        self.rows[&key]
            .get(&occurrence)
            .cloned()
            .ok_or_else(|| sql_error(rusqlite::Error::QueryReturnedNoRows))
    }

    fn rows_at(&self, snapshot: ExecutionId, cap: Revision) -> Result<Vec<OriginRow>, ExecutionError> {
        let query = if self.corrections && cap.get() != 0 {
            "SELECT o.occurrence_id,COALESCE(b.unit_id,o.unit_id),COALESCE(b.revision_id,o.revision_id),
                 CASE WHEN b.action_id IS NULL THEN l.predecessor_id ELSE b.predecessor_id END,
                 COALESCE(b.relation,l.relation),COALESCE(c.mapping_revision,0),
                 CASE WHEN COALESCE(b.relation,l.relation) IN ('new','unresolved')
                      THEN EXISTS(SELECT 1 FROM source_lineage_evidence e WHERE e.new_occurrence_id=o.occurrence_id)
                      ELSE 0 END
                 FROM source_occurrences o LEFT JOIN source_lineage l ON l.occurrence_id=o.occurrence_id
                 LEFT JOIN source_lineage_correction_bindings b ON b.occurrence_id=o.occurrence_id
                 AND b.action_id=(SELECT a.action_id FROM source_lineage_corrections a
                   JOIN source_lineage_correction_bindings x ON x.action_id=a.action_id
                   WHERE x.occurrence_id=o.occurrence_id AND a.mapping_revision<=?2
                   ORDER BY a.mapping_revision DESC LIMIT 1)
                 LEFT JOIN source_lineage_corrections c ON c.action_id=b.action_id
                 WHERE o.snapshot_id=?1 ORDER BY o.ordinal"
        } else {
            "SELECT o.occurrence_id,o.unit_id,o.revision_id,l.predecessor_id,l.relation,0,
                 CASE WHEN l.relation IN ('new','unresolved')
                      THEN EXISTS(SELECT 1 FROM source_lineage_evidence e WHERE e.new_occurrence_id=o.occurrence_id)
                      ELSE 0 END
                 FROM source_occurrences o LEFT JOIN source_lineage l ON l.occurrence_id=o.occurrence_id
                 WHERE o.snapshot_id=?1 AND ?2>=0 ORDER BY o.ordinal"
        };
        let mut statement = self.connection.prepare(query).map_err(sql_error)?;
        statement
            .query_map(params![snapshot.to_string(), cap.get() as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            })
            .map_err(sql_error)?
            .map(|row| {
                let (occurrence, unit, source, predecessor, relation, version, evidence) =
                    row.map_err(sql_error)?;
                Ok(OriginRow {
                    snapshot,
                    version: Revision::new(u64::try_from(version).map_err(|_| corrupt())?)?,
                    binding: SourceLineageBinding {
                        occurrence_id: id(occurrence)?,
                        unit_id: id(unit)?,
                        source_revision_id: id(source)?,
                        predecessor_id: predecessor.map(id).transpose()?,
                        relation,
                    },
                    evidence,
                })
            })
            .collect()
    }

    fn predecessor_version(
        &mut self,
        snapshot: ExecutionId,
        old: ExecutionId,
    ) -> Result<Revision, ExecutionError> {
        if !self.bases.contains_key(&snapshot) {
            let mut bases = BTreeMap::new();
            if self.captured_bases {
                let mut statement = self.connection.prepare(
                    "SELECT base_snapshot_id,mapping_revision FROM source_snapshot_mapping_bases WHERE snapshot_id=?1",
                ).map_err(sql_error)?;
                for row in statement
                    .query_map([snapshot.to_string()], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .map_err(sql_error)?
                {
                    let (base, version) = row.map_err(sql_error)?;
                    bases.insert(
                        id(base)?,
                        Revision::new(u64::try_from(version).map_err(|_| corrupt())?)?,
                    );
                }
            }
            self.bases.insert(snapshot, bases);
        }
        if let Some(version) = self.bases[&snapshot].get(&old) {
            return Ok(*version);
        }
        if let Some(version) = self.versions.get(&old) {
            return Ok(*version);
        }
        let version = mapping_revision(self.connection, old)?;
        self.versions.insert(old, version);
        Ok(version)
    }

    pub(in crate::persistence) fn unresolved_origin(
        &mut self,
        occurrence: ExecutionId,
        version: Revision,
    ) -> Result<Option<Vec<SourceLineageOrigin>>, ExecutionError> {
        let current = self.row(occurrence, version)?;
        self.unresolved_from(current)
    }

    pub(in crate::persistence) fn unresolved_in(
        &mut self,
        snapshot: ExecutionId,
        limit: usize,
        cancellation: &crate::execution::Cancellation,
    ) -> Result<Vec<(ExecutionId, ExecutionId)>, ExecutionError> {
        let version = mapping_revision(self.connection, snapshot)?;
        let mut unresolved = Vec::new();
        // Start with ordinal-ordered bindings. Only ancestor lookups need the
        // per-snapshot map used for traversal.
        for row in self.rows_at(snapshot, version)? {
            if cancellation.is_requested() {
                return Err(failure(ErrorCode::Cancelled, "review-read-cancelled"));
            }
            let ids = (row.binding.occurrence_id, row.binding.unit_id);
            if self.unresolved_from(row)?.is_some() {
                unresolved.push(ids);
                if unresolved.len() == limit {
                    break;
                }
            }
        }
        Ok(unresolved)
    }

    fn unresolved_from(
        &mut self,
        mut current: OriginRow,
    ) -> Result<Option<Vec<SourceLineageOrigin>>, ExecutionError> {
        let relation = current.binding.relation.as_str();
        if !matches!(relation, "unchanged" | "changed")
            && !(matches!(relation, "new" | "unresolved")
                && (current.evidence || current.version.get() > 0))
        {
            return Ok(None);
        }
        let mut seen = BTreeSet::new();
        let mut chain = Vec::new();
        loop {
            let occurrence = current.binding.occurrence_id;
            if !seen.insert(occurrence) {
                return Err(corrupt());
            }
            chain.push(SourceLineageOrigin {
                snapshot_id: current.snapshot,
                occurrence_id: occurrence,
                mapping_revision: current.version,
            });
            if matches!(current.binding.relation.as_str(), "new" | "unresolved") {
                return Ok((current.evidence || current.version.get() > 0).then_some(chain));
            }
            if !matches!(current.binding.relation.as_str(), "unchanged" | "changed") {
                return Ok(None);
            }
            let old = current.binding.predecessor_id.ok_or_else(corrupt)?;
            let old_snapshot = self.snapshot(old)?;
            let old_version = self.predecessor_version(current.snapshot, old_snapshot)?;
            let previous = self.row(old, old_version)?;
            if previous.binding.unit_id != current.binding.unit_id {
                return Err(corrupt());
            }
            if chain.len() > MAX_OCCURRENCES {
                return Err(failure(ErrorCode::LimitExceeded, "source-lineage-depth"));
            }
            current = previous;
        }
    }
}
