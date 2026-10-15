//! Bounded, read-only preview of a selected plain-text subset of TMX 1.4b.
//! A mapped row is evidence for comparison, never a saved translation or approval.

use crate::{
    Locale,
    execution::{ErrorCode, ExecutionError, codec},
};
use roxmltree::{Document, Error as XmlError, Node, ParsingOptions};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_TMX_INPUT_BYTES: usize = 128 * 1024;
pub const MAX_TMX_REPORT_BYTES: usize = 1024 * 1024;
const MAX_TUS: usize = 512;
const MAX_XML_NODES: u32 = 65_536;
const TMX_NS: &str = "http://www.lisa.org/tmx14";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const MAX_TUVS: usize = 1024;
const MAX_DEPTH: usize = 16;
const MAX_ELEMENTS: usize = 8192;
const MAX_ATTRIBUTES: usize = 32;
const MAX_SEG_BYTES: usize = 16 * 1024;
const MAX_PATH_BYTES: usize = 512;
const MAX_LOSS_SAMPLES: usize = 16;
const PROFILE: &str = "tmx-1.4b-plain-text-preview";

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmxExchangePreview {
    pub profile: String,
    pub digest: String,
    pub byte_len: u32,
    pub source_locale: String,
    pub target_locale: String,
    pub license: TmxLicenseStatus,
    pub header: TmxProvenance,
    pub rows: Vec<TmxExchangeRow>,
    pub losses: Vec<TmxLossEntry>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmxLicenseStatus {
    Unknown,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmxProvenance {
    pub creation_tool: Option<String>,
    pub creation_tool_version: Option<String>,
    pub original_tm_format: Option<String>,
    pub creation_id: Option<String>,
    pub creation_date: Option<String>,
    pub change_id: Option<String>,
    pub change_date: Option<String>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmxExchangeRow {
    pub ordinal: u32,
    pub tuid: Option<String>,
    pub source_text: Option<String>,
    pub target_text: Option<String>,
    pub status: TmxRowStatus,
    pub reasons: Vec<TmxRowReason>,
    pub effective_source_locale: Option<String>,
    pub tu_provenance: TmxProvenance,
    pub source_provenance: Option<TmxProvenance>,
    pub target_provenance: Option<TmxProvenance>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmxRowStatus {
    Eligible,
    Excluded,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmxRowReason {
    SourceDirectionMismatch,
    WildcardSourceDirection,
    MissingSource,
    MissingTarget,
    AmbiguousSource,
    AmbiguousTarget,
    InvalidLanguage,
    EmptySource,
    EmptyTarget,
    InlineMarkup,
    UnknownStructure,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmxLossKind {
    UnmappedMetadata,
    UnknownAttribute,
    UnknownElement,
    ExtraLanguage,
    DuplicateTuid,
    DuplicateLanguage,
    DirectionMismatch,
    WildcardDirection,
    InvalidLanguage,
    MissingSegment,
    EmptySegment,
    InlineMarkup,
    UnknownStructure,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmxLossEntry {
    pub kind: TmxLossKind,
    pub field: String,
    pub count: u32,
    pub samples: Vec<TmxLossSample>,
    pub unlisted: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmxLossSample {
    pub byte_offset: u32,
    pub ordinal: Option<u32>,
    pub path: String,
}

fn invalid(stage: &'static str) -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, stage)
}
fn limit(stage: &'static str) -> ExecutionError {
    ExecutionError::new(ErrorCode::LimitExceeded, stage)
}
fn canonical_locale(value: &str) -> Option<String> {
    Locale::parse(value).ok().map(Locale::into_string)
}
fn attributes(node: Node<'_, '_>) -> Result<BTreeMap<String, String>, ExecutionError> {
    let mut values = BTreeMap::new();
    for attr in node.attributes() {
        let key = match attr.namespace() {
            None => attr.name().to_owned(),
            Some(namespace) if namespace == XML_NS && attr.name() == "lang" => {
                "xml:lang".to_owned()
            }
            _ => return Err(invalid("tmx-namespace")),
        };
        if values.insert(key, attr.value().to_owned()).is_some() {
            return Err(invalid("tmx-duplicate-attribute"));
        }
    }
    Ok(values)
}
fn node_offset(node: Node<'_, '_>, bom_bytes: u32) -> Result<u32, ExecutionError> {
    u32::try_from(node.range().start)
        .ok()
        .and_then(|offset| offset.checked_add(bom_bytes))
        .ok_or_else(|| limit("tmx-offset"))
}
fn node_path(node: Node<'_, '_>) -> String {
    let ancestors: Vec<_> = node.ancestors().filter(|n| n.is_element()).collect();
    let mut path = String::new();
    for ancestor in ancestors.iter().rev() {
        path.push('/');
        path.push_str(ancestor.tag_name().name());
    }
    if path.len() <= MAX_PATH_BYTES {
        return path;
    }
    // A long legal XML name must not make an otherwise bounded preview fail.
    // The positional form still identifies the exact element in the document.
    let mut positional = String::new();
    for ancestor in ancestors.iter().rev() {
        let sibling_index = ancestor
            .prev_siblings()
            .filter(|sibling| sibling.is_element())
            .count();
        positional.push_str(&format!("/*[{sibling_index}]"));
    }
    positional
}
fn valid_xml_declaration(xml: &str) -> Result<(), ExecutionError> {
    if !xml.starts_with("<?xml") {
        return Ok(());
    }
    if !xml.starts_with("<?xml ") {
        return Err(invalid("tmx-declaration"));
    }
    let end = xml.find("?>").ok_or_else(|| invalid("tmx-declaration"))?;
    let body = &xml[5..end];
    // XML declaration pseudo-attributes have literal ASCII values. A reference
    // is not part of VersionNum, EncName or the yes/no standalone production.
    if body.contains('&') {
        return Err(invalid("tmx-declaration"));
    }
    let wrapper = format!("<declaration{body}/>");
    let options = ParsingOptions {
        allow_dtd: false,
        nodes_limit: 64,
        entity_resolver: None,
    };
    let parsed =
        Document::parse_with_options(&wrapper, options).map_err(|_| invalid("tmx-declaration"))?;
    let element = parsed.root_element();
    if element.namespaces().len() != 0 {
        return Err(invalid("tmx-declaration"));
    }
    let attrs: Vec<_> = element.attributes().collect();
    if attrs.is_empty() || attrs.len() > 3 || attrs.iter().any(|attr| attr.namespace().is_some()) {
        return Err(invalid("tmx-declaration"));
    }
    if attrs[0].name() != "version" || attrs[0].value() != "1.0" {
        return Err(invalid("tmx-xml-version"));
    }
    let mut index = 1;
    if attrs
        .get(index)
        .is_some_and(|attr| attr.name() == "encoding")
    {
        if !attrs[index].value().eq_ignore_ascii_case("utf-8") {
            return Err(invalid("tmx-encoding"));
        }
        index += 1;
    }
    if attrs
        .get(index)
        .is_some_and(|attr| attr.name() == "standalone")
    {
        if !matches!(attrs[index].value(), "yes" | "no") {
            return Err(invalid("tmx-standalone"));
        }
        index += 1;
    }
    if index != attrs.len() {
        return Err(invalid("tmx-declaration"));
    }
    Ok(())
}
fn validate_xml_document(doc: &Document<'_>, xml: &str) -> Result<(), ExecutionError> {
    let root = doc.root_element();
    let namespace = root.tag_name().namespace();
    if namespace.is_some() && namespace != Some(TMX_NS) {
        return Err(invalid("tmx-namespace"));
    }
    // roxmltree rejects nonempty DTDs when allow_dtd=false, but accepts an
    // empty declaration. Use its source ranges to distinguish a real prolog
    // DOCTYPE from the same literal text inside a preserved comment.
    for (offset, _) in xml[..root.range().start].match_indices("<!DOCTYPE") {
        let in_comment = doc
            .root()
            .children()
            .any(|node| node.is_comment() && node.range().contains(&offset));
        if !in_comment {
            return Err(invalid("tmx-doctype"));
        }
    }
    let mut element_count = 0;
    let mut tu_count = 0;
    let mut tuv_count = 0;
    for node in doc.descendants() {
        if node.is_pi() {
            return Err(invalid("tmx-processing-instruction"));
        }
        if !node.is_element() {
            continue;
        }
        element_count += 1;
        if element_count > MAX_ELEMENTS {
            return Err(limit("tmx-elements"));
        }
        let tag = node.tag_name();
        if tag.namespace() != namespace || node.namespaces().any(|ns| ns.name().is_some()) {
            return Err(invalid("tmx-namespace"));
        }
        let depth = node
            .ancestors()
            .filter(|ancestor| ancestor.is_element())
            .count();
        if depth > MAX_DEPTH {
            return Err(limit("tmx-depth"));
        }
        if node.attributes().len() > MAX_ATTRIBUTES {
            return Err(limit("tmx-attributes"));
        }
        for attr in node.attributes() {
            if attr.namespace().is_some()
                && !(attr.namespace() == Some(XML_NS) && attr.name() == "lang")
            {
                return Err(invalid("tmx-namespace"));
            }
        }
        match tag.name() {
            "tu" => {
                tu_count += 1;
                if tu_count > MAX_TUS {
                    return Err(limit("tmx-tu"));
                }
            }
            "tuv" => {
                tuv_count += 1;
                if tuv_count > MAX_TUVS {
                    return Err(limit("tmx-tuv"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn text_is_whitespace(node: Node<'_, '_>) -> bool {
    !node.is_text() || node.text().is_none_or(xml_s_only)
}
fn xml_s_only(text: &str) -> bool {
    text.chars()
        .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'))
}
fn provenance(values: &BTreeMap<String, String>) -> TmxProvenance {
    let get = |key: &str| values.get(key).cloned();
    TmxProvenance {
        creation_tool: get("creationtool"),
        creation_tool_version: get("creationtoolversion"),
        original_tm_format: get("o-tmf"),
        creation_id: get("creationid"),
        creation_date: get("creationdate"),
        change_id: get("changeid"),
        change_date: get("changedate"),
    }
}

#[derive(Default)]
struct LossBook {
    entries: BTreeMap<(TmxLossKind, String), TmxLossEntry>,
    samples: usize,
}
impl LossBook {
    fn add(
        &mut self,
        kind: TmxLossKind,
        field: &str,
        offset: u32,
        ordinal: Option<u32>,
        path: &str,
    ) -> Result<(), ExecutionError> {
        let entry = self
            .entries
            .entry((kind, field.to_owned()))
            .or_insert_with(|| TmxLossEntry {
                kind,
                field: field.to_owned(),
                count: 0,
                samples: Vec::new(),
                unlisted: 0,
            });
        entry.count = entry
            .count
            .checked_add(1)
            .ok_or_else(|| limit("tmx-loss-count"))?;
        if self.samples < MAX_LOSS_SAMPLES {
            entry.samples.push(TmxLossSample {
                byte_offset: offset,
                ordinal,
                path: path.to_owned(),
            });
            self.samples += 1;
        }
        Ok(())
    }
    fn finish(self) -> Vec<TmxLossEntry> {
        self.entries
            .into_values()
            .map(|mut entry| {
                entry.unlisted = entry.count - entry.samples.len() as u32;
                entry
            })
            .collect()
    }
}

struct Variant {
    locale: Option<String>,
    canonical_locale: Option<String>,
    provenance: TmxProvenance,
    text: String,
    seg_count: usize,
    inline: bool,
    unknown_structure: bool,
    offset: u32,
    path: String,
}
struct Unit {
    ordinal: u32,
    tuid: Option<String>,
    source_locale: String,
    provenance: TmxProvenance,
    variants: Vec<Variant>,
    unknown_structure: bool,
    offset: u32,
    path: String,
}
struct Parser {
    bom_bytes: u32,
    source_locale: String,
    target_locale: String,
    header: TmxProvenance,
    header_source_locale: String,
    seen_tuids: BTreeSet<String>,
    unit: Option<Unit>,
    rows: Vec<TmxExchangeRow>,
    losses: LossBook,
}
impl Parser {
    fn new(bom_bytes: u32, source_locale: String, target_locale: String) -> Self {
        Self {
            bom_bytes,
            source_locale,
            target_locale,
            header: TmxProvenance::default(),
            header_source_locale: String::new(),
            seen_tuids: BTreeSet::new(),
            unit: None,
            rows: Vec::new(),
            losses: LossBook::default(),
        }
    }
    fn loss(
        &mut self,
        kind: TmxLossKind,
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
    fn record_attrs(
        &mut self,
        node: Node<'_, '_>,
        values: &BTreeMap<String, String>,
        mapped: &[&str],
        unmapped: &[&str],
        ordinal: Option<u32>,
    ) -> Result<(), ExecutionError> {
        for key in values.keys() {
            if mapped.contains(&key.as_str()) {
                continue;
            }
            let kind = if unmapped.contains(&key.as_str()) {
                TmxLossKind::UnmappedMetadata
            } else {
                TmxLossKind::UnknownAttribute
            };
            self.loss(kind, key, node, ordinal)?;
        }
        Ok(())
    }
    fn process_metadata(
        &mut self,
        node: Node<'_, '_>,
        ordinal: Option<u32>,
    ) -> Result<(), ExecutionError> {
        self.loss(
            TmxLossKind::UnmappedMetadata,
            node.tag_name().name(),
            node,
            ordinal,
        )?;
        let values = attributes(node)?;
        self.record_attrs(node, &values, &[], &["type", "xml:lang"], ordinal)?;
        for descendant in node.descendants().skip(1).filter(|n| n.is_element()) {
            self.loss(
                TmxLossKind::UnknownElement,
                descendant.tag_name().name(),
                descendant,
                ordinal,
            )?;
            let values = attributes(descendant)?;
            self.record_attrs(descendant, &values, &[], &[], ordinal)?;
        }
        Ok(())
    }
    fn process_unknown(
        &mut self,
        node: Node<'_, '_>,
        ordinal: u32,
        inline: bool,
    ) -> Result<(), ExecutionError> {
        for descendant in node.descendants().filter(|n| n.is_element()) {
            let kind = if inline {
                TmxLossKind::InlineMarkup
            } else {
                TmxLossKind::UnknownElement
            };
            self.loss(
                kind,
                descendant.tag_name().name(),
                descendant,
                Some(ordinal),
            )?;
            let values = attributes(descendant)?;
            self.record_attrs(descendant, &values, &[], &[], Some(ordinal))?;
        }
        Ok(())
    }
    fn process_segment(
        &mut self,
        node: Node<'_, '_>,
        variant: &mut Variant,
        ordinal: u32,
    ) -> Result<(), ExecutionError> {
        let values = attributes(node)?;
        self.record_attrs(node, &values, &[], &[], Some(ordinal))?;
        let mut decoded_bytes = 0usize;
        for text_node in node.descendants().filter(|child| child.is_text()) {
            decoded_bytes = decoded_bytes
                .checked_add(text_node.text().unwrap_or("").len())
                .ok_or_else(|| limit("tmx-segment"))?;
            if decoded_bytes > MAX_SEG_BYTES {
                return Err(limit("tmx-segment"));
            }
        }
        let mut segment_text = String::new();
        for child in node.children() {
            if child.is_text() {
                let value = child.text().unwrap_or("");
                if segment_text
                    .len()
                    .checked_add(value.len())
                    .is_none_or(|n| n > MAX_SEG_BYTES)
                {
                    return Err(limit("tmx-segment"));
                }
                segment_text.push_str(value);
            } else if child.is_element() {
                variant.inline = true;
                self.process_unknown(child, ordinal, true)?;
            }
        }
        if variant.seg_count == 1 {
            variant.text = segment_text;
        }
        Ok(())
    }
    fn process_variant(
        &mut self,
        node: Node<'_, '_>,
        ordinal: u32,
    ) -> Result<Variant, ExecutionError> {
        let values = attributes(node)?;
        self.record_attrs(
            node,
            &values,
            &[
                "xml:lang",
                "creationtool",
                "creationtoolversion",
                "o-tmf",
                "creationid",
                "creationdate",
                "changeid",
                "changedate",
            ],
            &["usagecount", "lastusagedate", "datatype", "o-encoding"],
            Some(ordinal),
        )?;
        let locale = values.get("xml:lang").cloned();
        let mut variant = Variant {
            canonical_locale: locale.as_deref().and_then(canonical_locale),
            locale,
            provenance: provenance(&values),
            text: String::new(),
            seg_count: 0,
            inline: false,
            unknown_structure: false,
            offset: node_offset(node, self.bom_bytes)?,
            path: node_path(node),
        };
        for child in node.children() {
            if child.is_element() {
                match child.tag_name().name() {
                    "seg" => {
                        variant.seg_count += 1;
                        if variant.seg_count > 1 {
                            variant.unknown_structure = true;
                        }
                        self.process_segment(child, &mut variant, ordinal)?;
                    }
                    "note" | "prop" => self.process_metadata(child, Some(ordinal))?,
                    _ => {
                        variant.unknown_structure = true;
                        self.process_unknown(child, ordinal, false)?;
                    }
                }
            } else if !text_is_whitespace(child) {
                variant.unknown_structure = true;
                self.loss(TmxLossKind::UnknownStructure, "text", child, Some(ordinal))?;
            }
        }
        Ok(variant)
    }
    fn process_unit(&mut self, node: Node<'_, '_>) -> Result<(), ExecutionError> {
        let ordinal = u32::try_from(self.rows.len() + 1).map_err(|_| limit("tmx-tu"))?;
        let values = attributes(node)?;
        self.record_attrs(
            node,
            &values,
            &[
                "tuid",
                "srclang",
                "creationtool",
                "creationtoolversion",
                "o-tmf",
                "creationid",
                "creationdate",
                "changeid",
                "changedate",
            ],
            &[
                "usagecount",
                "lastusagedate",
                "datatype",
                "o-encoding",
                "segtype",
            ],
            Some(ordinal),
        )?;
        let tuid = values.get("tuid").cloned();
        if let Some(tuid) = &tuid {
            if !self.seen_tuids.insert(tuid.clone()) {
                self.loss(TmxLossKind::DuplicateTuid, "tuid", node, Some(ordinal))?;
            }
        }
        self.unit = Some(Unit {
            ordinal,
            tuid,
            source_locale: values
                .get("srclang")
                .cloned()
                .unwrap_or_else(|| self.header_source_locale.clone()),
            provenance: provenance(&values),
            variants: Vec::new(),
            unknown_structure: false,
            offset: node_offset(node, self.bom_bytes)?,
            path: node_path(node),
        });
        for child in node.children() {
            if child.is_element() {
                match child.tag_name().name() {
                    "tuv" => {
                        let variant = self.process_variant(child, ordinal)?;
                        self.unit
                            .as_mut()
                            .expect("unit is active")
                            .variants
                            .push(variant);
                    }
                    "note" | "prop" => self.process_metadata(child, Some(ordinal))?,
                    _ => {
                        self.unit
                            .as_mut()
                            .expect("unit is active")
                            .unknown_structure = true;
                        self.process_unknown(child, ordinal, false)?;
                    }
                }
            } else if !text_is_whitespace(child) {
                self.unit
                    .as_mut()
                    .expect("unit is active")
                    .unknown_structure = true;
                self.loss(TmxLossKind::UnknownStructure, "text", child, Some(ordinal))?;
            }
        }
        self.finish_unit()
    }
    fn process_header(&mut self, node: Node<'_, '_>) -> Result<(), ExecutionError> {
        let values = attributes(node)?;
        for required in [
            "creationtool",
            "creationtoolversion",
            "segtype",
            "o-tmf",
            "adminlang",
            "srclang",
            "datatype",
        ] {
            if values.get(required).is_none_or(String::is_empty) {
                return Err(invalid("tmx-header"));
            }
        }
        self.header_source_locale = values["srclang"].clone();
        if self.header_source_locale != "*all*"
            && canonical_locale(&self.header_source_locale).is_none()
        {
            return Err(invalid("tmx-header-language"));
        }
        self.header = provenance(&values);
        self.record_attrs(
            node,
            &values,
            &[
                "creationtool",
                "creationtoolversion",
                "o-tmf",
                "creationid",
                "creationdate",
                "changeid",
                "changedate",
                "srclang",
            ],
            &["segtype", "adminlang", "datatype", "o-encoding"],
            None,
        )?;
        for child in node.children() {
            if child.is_element() {
                match child.tag_name().name() {
                    "note" | "prop" => self.process_metadata(child, None)?,
                    _ => return Err(invalid("tmx-structure")),
                }
            } else if !text_is_whitespace(child) {
                return Err(invalid("tmx-text"));
            }
        }
        Ok(())
    }
    fn process_body(&mut self, node: Node<'_, '_>) -> Result<(), ExecutionError> {
        let values = attributes(node)?;
        self.record_attrs(node, &values, &[], &[], None)?;
        for child in node.children() {
            if child.is_element() {
                if child.tag_name().name() != "tu" {
                    return Err(invalid("tmx-structure"));
                }
                self.process_unit(child)?;
            } else if !text_is_whitespace(child) {
                return Err(invalid("tmx-text"));
            }
        }
        Ok(())
    }
    fn finish_unit(&mut self) -> Result<(), ExecutionError> {
        let unit = self.unit.take().ok_or_else(|| invalid("tmx-structure"))?;
        let path = &unit.path;
        let mut reasons = BTreeSet::new();
        let effective_source_locale = if unit.source_locale == "*all*" {
            reasons.insert(TmxRowReason::WildcardSourceDirection);
            self.losses.add(
                TmxLossKind::WildcardDirection,
                "srclang",
                unit.offset,
                Some(unit.ordinal),
                &path,
            )?;
            None
        } else {
            match canonical_locale(&unit.source_locale) {
                Some(locale) => {
                    if locale != self.source_locale {
                        reasons.insert(TmxRowReason::SourceDirectionMismatch);
                        self.losses.add(
                            TmxLossKind::DirectionMismatch,
                            "srclang",
                            unit.offset,
                            Some(unit.ordinal),
                            &path,
                        )?;
                    }
                    Some(locale)
                }
                None => {
                    reasons.insert(TmxRowReason::InvalidLanguage);
                    self.losses.add(
                        TmxLossKind::InvalidLanguage,
                        "srclang",
                        unit.offset,
                        Some(unit.ordinal),
                        &path,
                    )?;
                    None
                }
            }
        };
        if unit.unknown_structure {
            reasons.insert(TmxRowReason::UnknownStructure);
            self.losses.add(
                TmxLossKind::UnknownStructure,
                "tu",
                unit.offset,
                Some(unit.ordinal),
                &path,
            )?;
        }
        let mut by_locale: BTreeMap<String, Vec<&Variant>> = BTreeMap::new();
        for variant in &unit.variants {
            let variant_path = &variant.path;
            // Known extra languages are inventory only. Their defects remain
            // visible as losses, but cannot disqualify a clean selected pair.
            // An unrecognized language stays conservative because its role is unknown.
            let affects_pair = variant.canonical_locale.as_ref().is_none_or(|locale| {
                locale == &self.source_locale || locale == &self.target_locale
            });
            if variant.locale.is_none() || variant.canonical_locale.is_none() {
                reasons.insert(TmxRowReason::InvalidLanguage);
                self.losses.add(
                    TmxLossKind::InvalidLanguage,
                    "xml:lang",
                    variant.offset,
                    Some(unit.ordinal),
                    &variant_path,
                )?;
            }
            if variant.seg_count != 1 {
                if affects_pair {
                    reasons.insert(TmxRowReason::UnknownStructure);
                }
                self.losses.add(
                    if variant.seg_count == 0 {
                        TmxLossKind::MissingSegment
                    } else {
                        TmxLossKind::UnknownStructure
                    },
                    if variant.seg_count == 0 {
                        "seg"
                    } else {
                        "duplicate-seg"
                    },
                    variant.offset,
                    Some(unit.ordinal),
                    &variant_path,
                )?;
            }
            if variant.inline && affects_pair {
                reasons.insert(TmxRowReason::InlineMarkup);
            }
            if variant.unknown_structure {
                if affects_pair {
                    reasons.insert(TmxRowReason::UnknownStructure);
                }
                self.losses.add(
                    TmxLossKind::UnknownStructure,
                    "tuv",
                    variant.offset,
                    Some(unit.ordinal),
                    &variant_path,
                )?;
            }
            if variant.seg_count == 1 && xml_s_only(&variant.text) {
                self.losses.add(
                    TmxLossKind::EmptySegment,
                    "seg",
                    variant.offset,
                    Some(unit.ordinal),
                    &variant_path,
                )?;
            }
            if let Some(locale) = &variant.canonical_locale {
                if locale != &self.source_locale && locale != &self.target_locale {
                    self.losses.add(
                        TmxLossKind::ExtraLanguage,
                        "xml:lang",
                        variant.offset,
                        Some(unit.ordinal),
                        &variant_path,
                    )?;
                }
                by_locale.entry(locale.clone()).or_default().push(variant);
            }
        }
        for (locale, variants) in &by_locale {
            if variants.len() > 1 {
                for variant in variants.iter().skip(1) {
                    self.losses.add(
                        TmxLossKind::DuplicateLanguage,
                        "xml:lang",
                        variant.offset,
                        Some(unit.ordinal),
                        &variant.path,
                    )?;
                }
                if locale == &self.source_locale {
                    reasons.insert(TmxRowReason::AmbiguousSource);
                }
                if locale == &self.target_locale {
                    reasons.insert(TmxRowReason::AmbiguousTarget);
                }
            }
        }
        let source = by_locale
            .get(&self.source_locale)
            .filter(|list| list.len() == 1)
            .map(|list| list[0]);
        let target = by_locale
            .get(&self.target_locale)
            .filter(|list| list.len() == 1)
            .map(|list| list[0]);
        if source.is_none() && !reasons.contains(&TmxRowReason::AmbiguousSource) {
            reasons.insert(TmxRowReason::MissingSource);
            self.losses.add(
                TmxLossKind::MissingSegment,
                "source-tuv",
                unit.offset,
                Some(unit.ordinal),
                &path,
            )?;
        }
        if target.is_none() && !reasons.contains(&TmxRowReason::AmbiguousTarget) {
            reasons.insert(TmxRowReason::MissingTarget);
            self.losses.add(
                TmxLossKind::MissingSegment,
                "target-tuv",
                unit.offset,
                Some(unit.ordinal),
                &path,
            )?;
        }
        if source.is_some_and(|v| xml_s_only(&v.text)) {
            reasons.insert(TmxRowReason::EmptySource);
        }
        if target.is_some_and(|v| xml_s_only(&v.text)) {
            reasons.insert(TmxRowReason::EmptyTarget);
        }
        let mapped_text = |variant: Option<&Variant>| -> Option<String> {
            variant
                .filter(|v| v.seg_count == 1 && !v.inline && !v.unknown_structure)
                .map(|v| v.text.clone())
        };
        let source_text = mapped_text(source);
        let target_text = mapped_text(target);
        let status = if reasons.is_empty() && source_text.is_some() && target_text.is_some() {
            TmxRowStatus::Eligible
        } else {
            TmxRowStatus::Excluded
        };
        self.rows.push(TmxExchangeRow {
            ordinal: unit.ordinal,
            tuid: unit.tuid,
            source_text,
            target_text,
            status,
            reasons: reasons.into_iter().collect(),
            effective_source_locale,
            tu_provenance: unit.provenance,
            source_provenance: source.map(|v| v.provenance.clone()),
            target_provenance: target.map(|v| v.provenance.clone()),
        });
        Ok(())
    }

    fn parse(
        mut self,
        doc: &Document<'_>,
        bytes: &[u8],
    ) -> Result<TmxExchangePreview, ExecutionError> {
        let root = doc.root_element();
        if root.tag_name().name() != "tmx" {
            return Err(invalid("tmx-root"));
        }
        let values = attributes(root)?;
        if values.get("version").map(String::as_str) != Some("1.4") {
            return Err(invalid("tmx-version"));
        }
        self.record_attrs(root, &values, &["version"], &[], None)?;
        let mut children = Vec::new();
        for child in root.children() {
            if child.is_element() {
                children.push(child);
            } else if !text_is_whitespace(child) {
                return Err(invalid("tmx-text"));
            }
        }
        if children.len() != 2
            || children[0].tag_name().name() != "header"
            || children[1].tag_name().name() != "body"
        {
            return Err(invalid("tmx-structure"));
        }
        self.process_header(children[0])?;
        self.process_body(children[1])?;
        let preview = TmxExchangePreview {
            profile: PROFILE.to_owned(),
            digest: codec::digest(bytes),
            byte_len: u32::try_from(bytes.len()).map_err(|_| limit("tmx-input"))?,
            source_locale: self.source_locale,
            target_locale: self.target_locale,
            license: TmxLicenseStatus::Unknown,
            header: self.header,
            rows: self.rows,
            losses: self.losses.finish(),
        };
        codec::encode(&preview, MAX_TMX_REPORT_BYTES)?;
        Ok(preview)
    }
}

/// Validate and preview a bounded plain-text TMX document without persistence.
pub fn preview_tmx_exchange(
    bytes: &[u8],
    source_locale: &str,
    target_locale: &str,
) -> Result<TmxExchangePreview, ExecutionError> {
    if bytes.len() > MAX_TMX_INPUT_BYTES {
        return Err(limit("tmx-input"));
    }
    let source_locale =
        canonical_locale(source_locale).ok_or_else(|| invalid("tmx-source-locale"))?;
    let target_locale =
        canonical_locale(target_locale).ok_or_else(|| invalid("tmx-target-locale"))?;
    if source_locale == target_locale {
        return Err(invalid("tmx-locale-pair"));
    }
    let (xml_bytes, bom_bytes) = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        (&bytes[3..], 3)
    } else {
        (bytes, 0)
    };
    let xml = std::str::from_utf8(xml_bytes).map_err(|_| invalid("tmx-encoding"))?;
    let options = ParsingOptions {
        allow_dtd: false,
        nodes_limit: MAX_XML_NODES,
        entity_resolver: None,
    };
    let doc = Document::parse_with_options(xml, options).map_err(|error| match error {
        XmlError::NodesLimitReached
        | XmlError::AttributesLimitReached
        | XmlError::NamespacesLimitReached => limit("tmx-xml-capacity"),
        _ => invalid("tmx-xml"),
    })?;
    valid_xml_declaration(xml)?;
    validate_xml_document(&doc, xml)?;
    Parser::new(bom_bytes, source_locale, target_locale).parse(&doc, bytes)
}

#[cfg(test)]
#[path = "tmx_exchange_tests.rs"]
mod tests;
