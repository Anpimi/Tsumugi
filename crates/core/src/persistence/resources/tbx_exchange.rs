//! Bounded, read-only preview of recognizable TBX-Basic DCA material.
//! No term in this report is adopted, licensed, protected or approved.

use crate::execution::{ExecutionError, codec};
use roxmltree::Node;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use super::exchange_xml::{
    self, LossBook, TagBudget, XmlPolicy, attributes, canonical_locale, decoded_text_bytes,
    invalid, limit, node_offset, node_path, text_is_whitespace, xml_s_only,
};

pub const MAX_TBX_INPUT_BYTES: usize = exchange_xml::MAX_INPUT_BYTES;
pub const MAX_TBX_REPORT_BYTES: usize = exchange_xml::MAX_REPORT_BYTES;
const MAX_CONCEPTS: usize = 512;
const MAX_LANG_SECS: usize = 1024;
const MAX_TERM_SECS: usize = 1024;
const TBX_NS: &str = "urn:iso:std:iso:30042:ed-2";
const PROFILE: &str = "tbx-basic-dca-subset-preview";

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TbxExchangePreview {
    pub profile: String,
    pub digest: String,
    pub byte_len: u32,
    pub source_locale: String,
    pub target_locale: String,
    pub document_locale: String,
    pub titles: Vec<String>,
    pub source_descriptions: Vec<String>,
    pub license: TbxLicenseStatus,
    pub rows: Vec<TbxExchangeRow>,
    pub losses: Vec<TbxLossEntry>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TbxLicenseStatus {
    Unknown,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TbxExchangeRow {
    pub ordinal: u32,
    pub concept_id: Option<String>,
    pub source_terms: Vec<TbxTermPreview>,
    pub target_terms: Vec<TbxTermPreview>,
    pub status: TbxRowStatus,
    pub reasons: Vec<TbxRowReason>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TbxTermPreview {
    pub language_ordinal: u32,
    pub ordinal: u32,
    pub term_sec_id: Option<String>,
    pub text: Option<String>,
    pub usage_statuses: Vec<String>,
    pub sources: Vec<String>,
    pub reasons: Vec<TbxTermReason>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TbxRowStatus {
    PossibleMapping,
    Excluded,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TbxRowReason {
    MissingSource,
    MissingTarget,
    AmbiguousSource,
    AmbiguousTarget,
    InvalidLanguage,
    UnknownStructure,
    InvalidSourceTerm,
    InvalidTargetTerm,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TbxTermReason {
    MissingTerm,
    AmbiguousTerm,
    EmptyTerm,
    InlineMarkup,
    UnknownStructure,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TbxLossKind {
    UnmappedMetadata,
    UnknownAttribute,
    UnknownElement,
    UnknownDataCategory,
    ExtraLanguage,
    DuplicateConceptId,
    DuplicateTermId,
    DuplicateLanguage,
    DuplicateTermText,
    InvalidLanguage,
    MissingTerm,
    EmptyTerm,
    InlineMarkup,
    UnknownStructure,
    UnknownUsageStatus,
    DuplicateUsageStatus,
    SchemaHint,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TbxLossEntry {
    pub kind: TbxLossKind,
    pub field: String,
    pub count: u32,
    pub samples: Vec<TbxLossSample>,
    pub unlisted: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TbxLossSample {
    pub byte_offset: u32,
    pub ordinal: Option<u32>,
    pub path: String,
}

struct Language {
    locale: Option<String>,
    terms: Vec<TbxTermPreview>,
    term_locations: Vec<(u32, String)>,
    unknown_structure: bool,
    offset: u32,
    path: String,
}

struct Parser {
    bom_bytes: u32,
    source_locale: String,
    target_locale: String,
    document_locale: String,
    titles: Vec<String>,
    source_descriptions: Vec<String>,
    rows: Vec<TbxExchangeRow>,
    losses: LossBook<TbxLossKind>,
    seen_concept_ids: BTreeSet<String>,
    seen_term_ids: BTreeSet<String>,
    language_count: u32,
    term_count: u32,
}

impl Parser {
    fn structural_name(name: &str) -> bool {
        matches!(
            name,
            "tbx"
                | "tbxHeader"
                | "fileDesc"
                | "text"
                | "body"
                | "conceptEntry"
                | "langSec"
                | "termSec"
                | "term"
        )
    }

    fn has_structural_descendant(node: Node<'_, '_>) -> bool {
        node.descendants()
            .skip(1)
            .any(|child| child.is_element() && Self::structural_name(child.tag_name().name()))
    }

    fn new(bom_bytes: u32, source_locale: String, target_locale: String) -> Self {
        Self {
            bom_bytes,
            source_locale,
            target_locale,
            document_locale: String::new(),
            titles: Vec::new(),
            source_descriptions: Vec::new(),
            rows: Vec::new(),
            losses: LossBook::default(),
            seen_concept_ids: BTreeSet::new(),
            seen_term_ids: BTreeSet::new(),
            language_count: 0,
            term_count: 0,
        }
    }

    fn loss(
        &mut self,
        kind: TbxLossKind,
        field: &str,
        node: Node<'_, '_>,
        ordinal: Option<u32>,
    ) -> Result<(), ExecutionError> {
        self.losses.add(
            kind,
            field,
            node_offset(node, self.bom_bytes)?,
            ordinal,
            &node_path(node),
        )
    }

    fn attrs(
        &mut self,
        node: Node<'_, '_>,
        mapped: &[&str],
        ordinal: Option<u32>,
    ) -> Result<BTreeMap<String, String>, ExecutionError> {
        let values = attributes(node)?;
        for key in values.keys() {
            if !mapped.contains(&key.as_str()) {
                self.loss(TbxLossKind::UnknownAttribute, key, node, ordinal)?;
            }
        }
        Ok(values)
    }

    fn inline_losses(
        &mut self,
        node: Node<'_, '_>,
        ordinal: Option<u32>,
    ) -> Result<(), ExecutionError> {
        for descendant in node
            .descendants()
            .skip(1)
            .filter(|child| child.is_element())
        {
            self.loss(
                TbxLossKind::InlineMarkup,
                descendant.tag_name().name(),
                descendant,
                ordinal,
            )?;
            if Self::structural_name(descendant.tag_name().name()) {
                self.loss(
                    TbxLossKind::UnknownStructure,
                    descendant.tag_name().name(),
                    descendant,
                    ordinal,
                )?;
            }
            self.attrs(descendant, &[], ordinal)?;
        }
        Ok(())
    }

    // Return text only when all content is directly readable character data.
    // This intentionally never flattens nested markup.
    fn plain_text(
        &mut self,
        node: Node<'_, '_>,
        ordinal: Option<u32>,
        term: bool,
    ) -> Result<Option<String>, ExecutionError> {
        if term {
            decoded_text_bytes(node, exchange_xml::MAX_SEGMENT_BYTES, "tbx-term")?;
        }
        if node.children().any(|child| child.is_element()) {
            self.inline_losses(node, ordinal)?;
            return Ok(None);
        }
        let mut text = String::new();
        for child in node.children().filter(|child| child.is_text()) {
            text.push_str(child.text().unwrap_or(""));
        }
        Ok(Some(text))
    }

    fn metadata(
        &mut self,
        node: Node<'_, '_>,
        ordinal: Option<u32>,
    ) -> Result<bool, ExecutionError> {
        let name = node.tag_name().name();
        let mut structural = Self::structural_name(name);
        let recognized = matches!(
            name,
            "admin"
                | "descrip"
                | "descripGrp"
                | "note"
                | "ref"
                | "xref"
                | "termNote"
                | "transacGrp"
                | "transac"
                | "date"
                | "respPerson"
                | "back"
                | "p"
        );
        let values = self.attrs(node, &["type", "id"], ordinal)?;
        if !recognized {
            self.loss(TbxLossKind::UnknownElement, name, node, ordinal)?;
        } else if let Some(category) = values
            .get("type")
            .filter(|_| matches!(name, "descrip" | "admin" | "termNote"))
        {
            let known = match name {
                "descrip" => matches!(category.as_str(), "definition" | "context"),
                "admin" => category == "source",
                "termNote" => matches!(category.as_str(), "usageStatus" | "partOfSpeech"),
                _ => unreachable!(),
            };
            self.loss(
                if known {
                    TbxLossKind::UnmappedMetadata
                } else {
                    TbxLossKind::UnknownDataCategory
                },
                category,
                node,
                ordinal,
            )?;
        } else {
            self.loss(TbxLossKind::UnmappedMetadata, name, node, ordinal)?;
        }
        if values.contains_key("id") {
            self.loss(TbxLossKind::UnmappedMetadata, "id", node, ordinal)?;
        }
        if structural {
            self.loss(TbxLossKind::UnknownStructure, name, node, ordinal)?;
        }
        for child in node.children() {
            if child.is_element() {
                structural |= self.metadata(child, ordinal)?;
            }
        }
        Ok(structural)
    }

    fn header(&mut self, node: Node<'_, '_>) -> Result<(), ExecutionError> {
        self.attrs(node, &[], None)?;
        let mut file_desc = None;
        for child in node.children() {
            if child.is_element() {
                if child.tag_name().name() == "fileDesc" {
                    if file_desc.replace(child).is_some() {
                        return Err(invalid("tbx-header"));
                    }
                } else {
                    self.metadata(child, None)?;
                }
            } else if !text_is_whitespace(child) {
                return Err(invalid("tbx-header"));
            }
        }
        let file_desc = file_desc.ok_or_else(|| invalid("tbx-header"))?;
        self.attrs(file_desc, &[], None)?;
        for group in file_desc.children() {
            if !group.is_element() {
                if !text_is_whitespace(group) {
                    return Err(invalid("tbx-header"));
                }
                continue;
            }
            match group.tag_name().name() {
                "titleStmt" | "sourceDesc" => {
                    self.attrs(group, &[], None)?;
                    for child in group.children() {
                        if child.is_element() {
                            let expected = if group.tag_name().name() == "titleStmt" {
                                "title"
                            } else {
                                "p"
                            };
                            if child.tag_name().name() == expected {
                                self.attrs(child, &[], None)?;
                                if let Some(text) = self.plain_text(child, None, false)? {
                                    if expected == "title" {
                                        self.titles.push(text);
                                    } else {
                                        self.source_descriptions.push(text);
                                    }
                                }
                            } else {
                                self.metadata(child, None)?;
                            }
                        } else if !text_is_whitespace(child) {
                            self.loss(TbxLossKind::UnknownStructure, "text", child, None)?;
                        }
                    }
                }
                _ => {
                    self.metadata(group, None)?;
                }
            }
        }
        Ok(())
    }

    fn usage_class(value: &str) -> Option<&'static str> {
        match value {
            "preferred" => Some("preferred"),
            "admitted" => Some("admitted"),
            "deprecated" => Some("deprecated"),
            _ => None,
        }
    }

    fn term_sec(
        &mut self,
        node: Node<'_, '_>,
        language_ordinal: u32,
        concept_ordinal: u32,
    ) -> Result<TbxTermPreview, ExecutionError> {
        self.term_count += 1;
        let ordinal = self.term_count;
        let values = self.attrs(node, &["id"], Some(concept_ordinal))?;
        let term_sec_id = values.get("id").cloned();
        if let Some(id) = &term_sec_id {
            if !self.seen_term_ids.insert(id.clone()) {
                self.loss(
                    TbxLossKind::DuplicateTermId,
                    "id",
                    node,
                    Some(concept_ordinal),
                )?;
            }
        }
        let mut reasons = BTreeSet::new();
        let mut text = None;
        let mut term_seen = 0usize;
        let mut phase = 0u8; // term, then termNote, then other metadata
        let mut usage_statuses = Vec::new();
        let mut sources = Vec::new();
        let mut usage_status_count = 0usize;
        for child in node.children() {
            if !child.is_element() {
                if !text_is_whitespace(child) {
                    reasons.insert(TbxTermReason::UnknownStructure);
                    self.loss(
                        TbxLossKind::UnknownStructure,
                        "text",
                        child,
                        Some(concept_ordinal),
                    )?;
                }
                continue;
            }
            match child.tag_name().name() {
                "term" => {
                    term_seen += 1;
                    if phase != 0 || term_seen > 1 {
                        reasons.insert(TbxTermReason::UnknownStructure);
                        self.loss(
                            TbxLossKind::UnknownStructure,
                            "term-order",
                            child,
                            Some(concept_ordinal),
                        )?;
                    }
                    self.attrs(child, &[], Some(concept_ordinal))?;
                    let structural_inline = Self::has_structural_descendant(child);
                    let candidate = self.plain_text(child, Some(concept_ordinal), true)?;
                    if candidate.is_none() {
                        reasons.insert(TbxTermReason::InlineMarkup);
                    }
                    if structural_inline {
                        reasons.insert(TbxTermReason::UnknownStructure);
                    }
                    if candidate.as_deref().is_some_and(xml_s_only) {
                        reasons.insert(TbxTermReason::EmptyTerm);
                        self.loss(TbxLossKind::EmptyTerm, "term", child, Some(concept_ordinal))?;
                    }
                    if term_seen == 1 {
                        text = candidate;
                    }
                }
                "termNote" => {
                    if term_seen == 0 || phase == 2 {
                        reasons.insert(TbxTermReason::UnknownStructure);
                        self.loss(
                            TbxLossKind::UnknownStructure,
                            "termNote-order",
                            child,
                            Some(concept_ordinal),
                        )?;
                    }
                    phase = 1;
                    let values = attributes(child)?;
                    if values.get("type").map(String::as_str) == Some("usageStatus") {
                        self.attrs(child, &["type"], Some(concept_ordinal))?;
                        if usage_status_count > 0 {
                            self.loss(
                                TbxLossKind::DuplicateUsageStatus,
                                "usageStatus",
                                child,
                                Some(concept_ordinal),
                            )?;
                        }
                        usage_status_count += 1;
                        let structural_inline = Self::has_structural_descendant(child);
                        if let Some(value) = self.plain_text(child, Some(concept_ordinal), false)? {
                            match Self::usage_class(&value) {
                                Some(_) => {}
                                None => self.loss(
                                    TbxLossKind::UnknownUsageStatus,
                                    "usageStatus",
                                    child,
                                    Some(concept_ordinal),
                                )?,
                            }
                            usage_statuses.push(value);
                        } else {
                            reasons.insert(TbxTermReason::InlineMarkup);
                        }
                        if structural_inline {
                            reasons.insert(TbxTermReason::UnknownStructure);
                        }
                    } else {
                        if self.metadata(child, Some(concept_ordinal))? {
                            reasons.insert(TbxTermReason::UnknownStructure);
                        }
                    }
                }
                "admin" => {
                    phase = 2;
                    let values = attributes(child)?;
                    if values.get("type").map(String::as_str) == Some("source") {
                        self.attrs(child, &["type"], Some(concept_ordinal))?;
                        let structural_inline = Self::has_structural_descendant(child);
                        if let Some(value) = self.plain_text(child, Some(concept_ordinal), false)? {
                            sources.push(value);
                        } else {
                            reasons.insert(TbxTermReason::InlineMarkup);
                        }
                        if structural_inline {
                            reasons.insert(TbxTermReason::UnknownStructure);
                        }
                    } else {
                        if self.metadata(child, Some(concept_ordinal))? {
                            reasons.insert(TbxTermReason::UnknownStructure);
                        }
                    }
                }
                "descrip" | "descripGrp" | "note" | "ref" | "xref" | "transacGrp" => {
                    phase = 2;
                    if self.metadata(child, Some(concept_ordinal))? {
                        reasons.insert(TbxTermReason::UnknownStructure);
                    }
                }
                _ => {
                    phase = 2;
                    reasons.insert(TbxTermReason::UnknownStructure);
                    self.metadata(child, Some(concept_ordinal))?;
                }
            }
        }
        if term_seen == 0 {
            reasons.insert(TbxTermReason::MissingTerm);
            self.loss(
                TbxLossKind::MissingTerm,
                "term",
                node,
                Some(concept_ordinal),
            )?;
        } else if term_seen > 1 {
            reasons.insert(TbxTermReason::AmbiguousTerm);
            text = None;
        }
        Ok(TbxTermPreview {
            language_ordinal,
            ordinal,
            term_sec_id,
            text,
            usage_statuses,
            sources,
            reasons: reasons.into_iter().collect(),
        })
    }

    fn language(
        &mut self,
        node: Node<'_, '_>,
        concept_ordinal: u32,
    ) -> Result<Language, ExecutionError> {
        self.language_count += 1;
        let language_ordinal = self.language_count;
        let values = self.attrs(node, &["xml:lang"], Some(concept_ordinal))?;
        let locale = values
            .get("xml:lang")
            .and_then(|value| canonical_locale(value));
        if locale.is_none() {
            self.loss(
                TbxLossKind::InvalidLanguage,
                "xml:lang",
                node,
                Some(concept_ordinal),
            )?;
        }
        let mut terms = Vec::new();
        let mut term_locations = Vec::new();
        let mut unknown_structure = false;
        let mut seen_terms = false;
        for child in node.children() {
            if !child.is_element() {
                if !text_is_whitespace(child) {
                    unknown_structure = true;
                    self.loss(
                        TbxLossKind::UnknownStructure,
                        "text",
                        child,
                        Some(concept_ordinal),
                    )?;
                }
                continue;
            }
            match child.tag_name().name() {
                "termSec" => {
                    seen_terms = true;
                    term_locations.push((node_offset(child, self.bom_bytes)?, node_path(child)));
                    terms.push(self.term_sec(child, language_ordinal, concept_ordinal)?);
                }
                "descrip" | "descripGrp" | "admin" | "note" | "ref" | "xref" | "transacGrp" => {
                    if seen_terms {
                        unknown_structure = true;
                        self.loss(
                            TbxLossKind::UnknownStructure,
                            "lang-order",
                            child,
                            Some(concept_ordinal),
                        )?;
                    }
                    unknown_structure |= self.metadata(child, Some(concept_ordinal))?;
                }
                _ => {
                    unknown_structure = true;
                    self.metadata(child, Some(concept_ordinal))?;
                }
            }
        }
        Ok(Language {
            locale,
            terms,
            term_locations,
            unknown_structure,
            offset: node_offset(node, self.bom_bytes)?,
            path: node_path(node),
        })
    }

    fn concept(&mut self, node: Node<'_, '_>) -> Result<(), ExecutionError> {
        let ordinal = u32::try_from(self.rows.len() + 1).map_err(|_| limit("tbx-concept"))?;
        let values = self.attrs(node, &["id"], Some(ordinal))?;
        let concept_id = values.get("id").cloned();
        if let Some(id) = &concept_id {
            if !self.seen_concept_ids.insert(id.clone()) {
                self.loss(TbxLossKind::DuplicateConceptId, "id", node, Some(ordinal))?;
            }
        }
        let mut languages = Vec::new();
        let mut unknown_structure = false;
        let mut seen_languages = false;
        for child in node.children() {
            if !child.is_element() {
                if !text_is_whitespace(child) {
                    unknown_structure = true;
                    self.loss(TbxLossKind::UnknownStructure, "text", child, Some(ordinal))?;
                }
                continue;
            }
            match child.tag_name().name() {
                "langSec" => {
                    seen_languages = true;
                    languages.push(self.language(child, ordinal)?);
                }
                "descrip" | "descripGrp" | "admin" | "note" | "ref" | "xref" | "transacGrp" => {
                    if seen_languages {
                        unknown_structure = true;
                        self.loss(
                            TbxLossKind::UnknownStructure,
                            "concept-order",
                            child,
                            Some(ordinal),
                        )?;
                    }
                    unknown_structure |= self.metadata(child, Some(ordinal))?;
                }
                _ => {
                    unknown_structure = true;
                    self.metadata(child, Some(ordinal))?;
                }
            }
        }
        let mut reasons = BTreeSet::new();
        if unknown_structure {
            reasons.insert(TbxRowReason::UnknownStructure);
        }
        let mut by_locale: BTreeMap<String, Vec<&Language>> = BTreeMap::new();
        for language in &languages {
            if let Some(locale) = &language.locale {
                if locale != &self.source_locale && locale != &self.target_locale {
                    self.losses.add(
                        TbxLossKind::ExtraLanguage,
                        "xml:lang",
                        language.offset,
                        Some(ordinal),
                        &language.path,
                    )?;
                }
                by_locale.entry(locale.clone()).or_default().push(language);
            } else {
                reasons.insert(TbxRowReason::InvalidLanguage);
            }
        }
        for (locale, list) in &by_locale {
            for language in list.iter().skip(1) {
                self.losses.add(
                    TbxLossKind::DuplicateLanguage,
                    "xml:lang",
                    language.offset,
                    Some(ordinal),
                    &language.path,
                )?;
            }
            if list.len() > 1 {
                if locale == &self.source_locale {
                    reasons.insert(TbxRowReason::AmbiguousSource);
                }
                if locale == &self.target_locale {
                    reasons.insert(TbxRowReason::AmbiguousTarget);
                }
            }
        }
        let source_languages = by_locale.get(&self.source_locale);
        let target_languages = by_locale.get(&self.target_locale);
        let source_terms: Vec<_> = source_languages
            .into_iter()
            .flat_map(|list| list.iter())
            .flat_map(|lang| lang.terms.iter().cloned())
            .collect();
        let target_terms: Vec<_> = target_languages
            .into_iter()
            .flat_map(|list| list.iter())
            .flat_map(|lang| lang.terms.iter().cloned())
            .collect();
        if source_terms.is_empty() && !reasons.contains(&TbxRowReason::AmbiguousSource) {
            reasons.insert(TbxRowReason::MissingSource);
        }
        if target_terms.is_empty() && !reasons.contains(&TbxRowReason::AmbiguousTarget) {
            reasons.insert(TbxRowReason::MissingTarget);
        }
        if source_terms.len() > 1 {
            reasons.insert(TbxRowReason::AmbiguousSource);
        }
        if target_terms.len() > 1 {
            reasons.insert(TbxRowReason::AmbiguousTarget);
        }
        if source_languages.is_some_and(|list| list.iter().any(|lang| lang.unknown_structure))
            || target_languages.is_some_and(|list| list.iter().any(|lang| lang.unknown_structure))
        {
            reasons.insert(TbxRowReason::UnknownStructure);
        }
        if source_terms
            .iter()
            .any(|term| !term.reasons.is_empty() || term.text.is_none())
        {
            reasons.insert(TbxRowReason::InvalidSourceTerm);
        }
        if target_terms
            .iter()
            .any(|term| !term.reasons.is_empty() || term.text.is_none())
        {
            reasons.insert(TbxRowReason::InvalidTargetTerm);
        }
        let mut seen_text = BTreeSet::new();
        for language in &languages {
            if let Some(locale) = &language.locale {
                for (term, (offset, path)) in language.terms.iter().zip(&language.term_locations) {
                    if let Some(text) = &term.text {
                        if !seen_text.insert((locale, text)) {
                            self.losses.add(
                                TbxLossKind::DuplicateTermText,
                                "term",
                                *offset,
                                Some(ordinal),
                                path,
                            )?;
                        }
                    }
                }
            }
        }
        let status = if reasons.is_empty() && source_terms.len() == 1 && target_terms.len() == 1 {
            TbxRowStatus::PossibleMapping
        } else {
            TbxRowStatus::Excluded
        };
        self.rows.push(TbxExchangeRow {
            ordinal,
            concept_id,
            source_terms,
            target_terms,
            status,
            reasons: reasons.into_iter().collect(),
        });
        Ok(())
    }

    fn parse(
        mut self,
        root: Node<'_, '_>,
        bytes: &[u8],
    ) -> Result<TbxExchangePreview, ExecutionError> {
        if root.tag_name().name() != "tbx" {
            return Err(invalid("tbx-root"));
        }
        let values = self.attrs(root, &["type", "style", "xml:lang"], None)?;
        if values.get("type").map(String::as_str) != Some("TBX-Basic")
            || values.get("style").map(String::as_str) != Some("dca")
        {
            return Err(invalid("tbx-profile"));
        }
        self.document_locale = values
            .get("xml:lang")
            .filter(|raw| canonical_locale(raw).is_some())
            .cloned()
            .ok_or_else(|| invalid("tbx-document-language"))?;
        let children: Vec<_> = root.children().filter(|node| node.is_element()).collect();
        if root.children().any(|node| !text_is_whitespace(node))
            || children.len() != 2
            || children[0].tag_name().name() != "tbxHeader"
            || children[1].tag_name().name() != "text"
        {
            return Err(invalid("tbx-structure"));
        }
        self.header(children[0])?;
        let text = children[1];
        self.attrs(text, &[], None)?;
        let text_children: Vec<_> = text.children().filter(|node| node.is_element()).collect();
        if text.children().any(|node| !text_is_whitespace(node))
            || text_children.len() != 1
            || text_children[0].tag_name().name() != "body"
        {
            return Err(invalid("tbx-structure"));
        }
        let body = text_children[0];
        self.attrs(body, &[], None)?;
        let mut seen_back = false;
        for child in body.children() {
            if child.is_element() {
                match child.tag_name().name() {
                    "conceptEntry" if !seen_back => self.concept(child)?,
                    "back" if !seen_back => {
                        seen_back = true;
                        self.metadata(child, None)?;
                    }
                    _ => return Err(invalid("tbx-structure")),
                }
            } else if !text_is_whitespace(child) {
                return Err(invalid("tbx-structure"));
            }
        }
        let preview = TbxExchangePreview {
            profile: PROFILE.to_owned(),
            digest: codec::digest(bytes),
            byte_len: u32::try_from(bytes.len()).map_err(|_| limit("tbx-input"))?,
            source_locale: self.source_locale,
            target_locale: self.target_locale,
            document_locale: self.document_locale,
            titles: self.titles,
            source_descriptions: self.source_descriptions,
            license: TbxLicenseStatus::Unknown,
            rows: self.rows,
            losses: self
                .losses
                .finish()
                .into_iter()
                .map(|entry| TbxLossEntry {
                    kind: entry.kind,
                    field: entry.field,
                    count: entry.count,
                    unlisted: entry.unlisted,
                    samples: entry
                        .samples
                        .into_iter()
                        .map(|sample| TbxLossSample {
                            byte_offset: sample.byte_offset,
                            ordinal: sample.ordinal,
                            path: sample.path,
                        })
                        .collect(),
                })
                .collect(),
        };
        codec::encode(&preview, MAX_TBX_REPORT_BYTES)?;
        Ok(preview)
    }
}

/// Preview the selected TBX-Basic DCA subset without mutating project data.
pub fn preview_tbx_exchange(
    bytes: &[u8],
    source_locale: &str,
    target_locale: &str,
) -> Result<TbxExchangePreview, ExecutionError> {
    if bytes.len() > MAX_TBX_INPUT_BYTES {
        return Err(limit("tbx-input"));
    }
    let source_locale =
        canonical_locale(source_locale).ok_or_else(|| invalid("tbx-source-locale"))?;
    let target_locale =
        canonical_locale(target_locale).ok_or_else(|| invalid("tbx-target-locale"))?;
    if source_locale == target_locale {
        return Err(invalid("tbx-locale-pair"));
    }
    static BUDGETS: &[TagBudget] = &[
        TagBudget {
            name: "conceptEntry",
            max: MAX_CONCEPTS,
            stage: "tbx-concept",
        },
        TagBudget {
            name: "langSec",
            max: MAX_LANG_SECS,
            stage: "tbx-lang-sec",
        },
        TagBudget {
            name: "termSec",
            max: MAX_TERM_SECS,
            stage: "tbx-term-sec",
        },
    ];
    let parsed = exchange_xml::parse_xml(
        bytes,
        &XmlPolicy {
            prefix: "tbx",
            namespace: TBX_NS,
            require_namespace: true,
            allow_xml_model_hint: true,
            tag_budgets: BUDGETS,
        },
    )?;
    let mut parser = Parser::new(parsed.bom_bytes, source_locale, target_locale);
    for hint in parsed.doc.root().children().filter(|node| node.is_pi()) {
        let index = hint
            .prev_siblings()
            .filter(|sibling| sibling.pi().is_some_and(|pi| pi.target == "xml-model"))
            .count();
        let path = format!("/processing-instruction('xml-model')[{index}]");
        parser.losses.add(
            TbxLossKind::SchemaHint,
            "xml-model",
            node_offset(hint, parsed.bom_bytes)?,
            None,
            &path,
        )?;
    }
    parser.parse(parsed.doc.root_element(), bytes)
}

#[cfg(test)]
#[path = "tbx_exchange_tests.rs"]
mod tests;
