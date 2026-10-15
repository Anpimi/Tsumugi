//! Shared, read-only XML boundary for bounded exchange previews.

use crate::{
    Locale,
    execution::{ErrorCode, ExecutionError},
};
use roxmltree::{Document, Error as XmlError, Node, ParsingOptions};
use std::collections::BTreeMap;

pub(super) const MAX_INPUT_BYTES: usize = 128 * 1024;
pub(super) const MAX_REPORT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_SEGMENT_BYTES: usize = 16 * 1024;
pub(super) const MAX_LOSS_SAMPLES: usize = 16;
const MAX_XML_NODES: u32 = 65_536;
pub(super) const MAX_ELEMENTS: usize = 8192;
pub(super) const MAX_DEPTH: usize = 16;
pub(super) const MAX_ATTRIBUTES: usize = 32;
pub(super) const MAX_PATH_BYTES: usize = 512;
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

pub(super) fn invalid(stage: &str) -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, stage)
}
pub(super) fn limit(stage: &str) -> ExecutionError {
    ExecutionError::new(ErrorCode::LimitExceeded, stage)
}
pub(super) fn canonical_locale(value: &str) -> Option<String> {
    Locale::parse(value).ok().map(Locale::into_string)
}

#[derive(Clone, Copy)]
pub(super) struct TagBudget {
    pub name: &'static str,
    pub max: usize,
    pub stage: &'static str,
}

pub(super) struct XmlPolicy {
    pub prefix: &'static str,
    pub namespace: &'static str,
    pub require_namespace: bool,
    pub allow_xml_model_hint: bool,
    pub tag_budgets: &'static [TagBudget],
}

pub(super) struct ParsedXml<'a> {
    pub doc: Document<'a>,
    pub bom_bytes: u32,
}

fn stage(policy: &XmlPolicy, suffix: &str) -> String {
    format!("{}-{suffix}", policy.prefix)
}

pub(super) fn parse_xml<'a>(
    bytes: &'a [u8],
    policy: &XmlPolicy,
) -> Result<ParsedXml<'a>, ExecutionError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(limit(&stage(policy, "input")));
    }
    let (xml_bytes, bom_bytes) = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        (&bytes[3..], 3)
    } else {
        (bytes, 0)
    };
    let xml = std::str::from_utf8(xml_bytes).map_err(|_| invalid(&stage(policy, "encoding")))?;
    let options = ParsingOptions {
        allow_dtd: false,
        nodes_limit: MAX_XML_NODES,
        entity_resolver: None,
    };
    let doc = Document::parse_with_options(xml, options).map_err(|error| match error {
        XmlError::NodesLimitReached
        | XmlError::AttributesLimitReached
        | XmlError::NamespacesLimitReached => limit(&stage(policy, "xml-capacity")),
        _ => invalid(&stage(policy, "xml")),
    })?;
    valid_xml_declaration(xml, policy)?;
    validate_document(&doc, xml, policy)?;
    Ok(ParsedXml { doc, bom_bytes })
}

fn valid_xml_declaration(xml: &str, policy: &XmlPolicy) -> Result<(), ExecutionError> {
    if !xml.starts_with("<?xml") {
        return Ok(());
    }
    // The declaration target is exactly `xml`. A target such as `xml-model`
    // is a processing instruction and is checked by the PI policy below.
    if !matches!(
        xml.as_bytes().get(5).copied(),
        Some(b' ' | b'\t' | b'\r' | b'\n' | b'?')
    ) {
        return Ok(());
    }
    if !xml.starts_with("<?xml ") {
        return Err(invalid(&stage(policy, "declaration")));
    }
    let end = xml
        .find("?>")
        .ok_or_else(|| invalid(&stage(policy, "declaration")))?;
    let body = &xml[5..end];
    // Declaration values are literal XML productions, not entity references.
    if body.contains('&') {
        return Err(invalid(&stage(policy, "declaration")));
    }
    let wrapper = format!("<declaration{body}/>");
    let options = ParsingOptions {
        allow_dtd: false,
        nodes_limit: 64,
        entity_resolver: None,
    };
    let parsed = Document::parse_with_options(&wrapper, options)
        .map_err(|_| invalid(&stage(policy, "declaration")))?;
    let element = parsed.root_element();
    if element.namespaces().len() != 0 {
        return Err(invalid(&stage(policy, "declaration")));
    }
    let attrs: Vec<_> = element.attributes().collect();
    if attrs.is_empty() || attrs.len() > 3 || attrs.iter().any(|attr| attr.namespace().is_some()) {
        return Err(invalid(&stage(policy, "declaration")));
    }
    if attrs[0].name() != "version" || attrs[0].value() != "1.0" {
        return Err(invalid(&stage(policy, "xml-version")));
    }
    let mut index = 1;
    if attrs
        .get(index)
        .is_some_and(|attr| attr.name() == "encoding")
    {
        if !attrs[index].value().eq_ignore_ascii_case("utf-8") {
            return Err(invalid(&stage(policy, "encoding")));
        }
        index += 1;
    }
    if attrs
        .get(index)
        .is_some_and(|attr| attr.name() == "standalone")
    {
        if !matches!(attrs[index].value(), "yes" | "no") {
            return Err(invalid(&stage(policy, "standalone")));
        }
        index += 1;
    }
    if index != attrs.len() {
        return Err(invalid(&stage(policy, "declaration")));
    }
    Ok(())
}

fn validate_document(
    doc: &Document<'_>,
    xml: &str,
    policy: &XmlPolicy,
) -> Result<(), ExecutionError> {
    let root = doc.root_element();
    let namespace = root.tag_name().namespace();
    if (policy.require_namespace && namespace != Some(policy.namespace))
        || (!policy.require_namespace && namespace.is_some() && namespace != Some(policy.namespace))
    {
        return Err(invalid(&stage(policy, "namespace")));
    }
    // roxmltree accepts an empty DOCTYPE with DTD disabled. Source ranges
    // distinguish a declaration from identical text inside a comment or PI.
    for (offset, _) in xml[..root.range().start].match_indices("<!DOCTYPE") {
        let quoted = doc
            .root()
            .children()
            .any(|node| (node.is_comment() || node.is_pi()) && node.range().contains(&offset));
        if !quoted {
            return Err(invalid(&stage(policy, "doctype")));
        }
    }
    let mut element_count = 0;
    let mut tag_counts = vec![0usize; policy.tag_budgets.len()];
    for node in doc.descendants() {
        if node.is_pi() {
            let allowed_hint = policy.allow_xml_model_hint
                && node.parent() == Some(doc.root())
                && node.range().start < root.range().start
                && node.pi().is_some_and(|pi| pi.target == "xml-model");
            if !allowed_hint {
                return Err(invalid(&stage(policy, "processing-instruction")));
            }
        }
        if !node.is_element() {
            continue;
        }
        element_count += 1;
        if element_count > MAX_ELEMENTS {
            return Err(limit(&stage(policy, "elements")));
        }
        if node.tag_name().namespace() != namespace
            || node.namespaces().any(|ns| ns.name().is_some())
        {
            return Err(invalid(&stage(policy, "namespace")));
        }
        let depth = node
            .ancestors()
            .filter(|ancestor| ancestor.is_element())
            .count();
        if depth > MAX_DEPTH {
            return Err(limit(&stage(policy, "depth")));
        }
        if node.attributes().len() > MAX_ATTRIBUTES {
            return Err(limit(&stage(policy, "attributes")));
        }
        for attr in node.attributes() {
            if attr.namespace().is_some()
                && !(attr.namespace() == Some(XML_NS) && attr.name() == "lang")
            {
                return Err(invalid(&stage(policy, "namespace")));
            }
        }
        for (index, budget) in policy.tag_budgets.iter().enumerate() {
            if node.tag_name().name() == budget.name {
                tag_counts[index] += 1;
                if tag_counts[index] > budget.max {
                    return Err(limit(budget.stage));
                }
            }
        }
    }
    Ok(())
}

pub(super) fn attributes(node: Node<'_, '_>) -> Result<BTreeMap<String, String>, ExecutionError> {
    let mut values = BTreeMap::new();
    for attr in node.attributes() {
        let key = match attr.namespace() {
            None => attr.name().to_owned(),
            Some(namespace) if namespace == XML_NS && attr.name() == "lang" => {
                "xml:lang".to_owned()
            }
            _ => return Err(invalid("exchange-namespace")),
        };
        if values.insert(key, attr.value().to_owned()).is_some() {
            return Err(invalid("exchange-duplicate-attribute"));
        }
    }
    Ok(values)
}

pub(super) fn node_offset(node: Node<'_, '_>, bom_bytes: u32) -> Result<u32, ExecutionError> {
    u32::try_from(node.range().start)
        .ok()
        .and_then(|offset| offset.checked_add(bom_bytes))
        .ok_or_else(|| limit("exchange-offset"))
}

pub(super) fn node_path(node: Node<'_, '_>) -> String {
    let ancestors: Vec<_> = node.ancestors().filter(|n| n.is_element()).collect();
    let mut path = String::new();
    for ancestor in ancestors.iter().rev() {
        path.push('/');
        path.push_str(ancestor.tag_name().name());
    }
    if path.len() <= MAX_PATH_BYTES {
        return path;
    }
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

pub(super) fn xml_s_only(text: &str) -> bool {
    text.chars()
        .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'))
}
pub(super) fn text_is_whitespace(node: Node<'_, '_>) -> bool {
    !node.is_text() || node.text().is_none_or(xml_s_only)
}

pub(super) fn decoded_text_bytes(
    node: Node<'_, '_>,
    max: usize,
    stage: &str,
) -> Result<usize, ExecutionError> {
    let mut bytes = 0usize;
    for child in node.descendants().filter(|child| child.is_text()) {
        bytes = bytes
            .checked_add(child.text().unwrap_or("").len())
            .ok_or_else(|| limit(stage))?;
        if bytes > max {
            return Err(limit(stage));
        }
    }
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub(super) struct LossSample {
    pub byte_offset: u32,
    pub ordinal: Option<u32>,
    pub path: String,
}
#[derive(Clone, Debug)]
pub(super) struct LossEntry<K> {
    pub kind: K,
    pub field: String,
    pub count: u32,
    pub samples: Vec<LossSample>,
    pub unlisted: u32,
}
pub(super) struct LossBook<K: Ord + Copy> {
    entries: BTreeMap<(K, String), LossEntry<K>>,
    samples: usize,
}
impl<K: Ord + Copy> Default for LossBook<K> {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            samples: 0,
        }
    }
}
impl<K: Ord + Copy> LossBook<K> {
    pub fn add(
        &mut self,
        kind: K,
        field: &str,
        offset: u32,
        ordinal: Option<u32>,
        path: &str,
    ) -> Result<(), ExecutionError> {
        let entry = self
            .entries
            .entry((kind, field.to_owned()))
            .or_insert_with(|| LossEntry {
                kind,
                field: field.to_owned(),
                count: 0,
                samples: Vec::new(),
                unlisted: 0,
            });
        entry.count = entry
            .count
            .checked_add(1)
            .ok_or_else(|| limit("exchange-loss-count"))?;
        if self.samples < MAX_LOSS_SAMPLES {
            entry.samples.push(LossSample {
                byte_offset: offset,
                ordinal,
                path: path.to_owned(),
            });
            self.samples += 1;
        }
        Ok(())
    }
    pub fn finish(self) -> Vec<LossEntry<K>> {
        self.entries
            .into_values()
            .map(|mut entry| {
                entry.unlisted = entry.count - entry.samples.len() as u32;
                entry
            })
            .collect()
    }
}
