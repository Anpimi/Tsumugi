use std::{cmp::Ordering, fmt, str::FromStr};

use language_tags::LanguageTag;
use uuid::Uuid;

/// Stable identity for a project. Core creates it once and keeps it separate
/// from the directory used to store the project.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ProjectId(Uuid);

impl ProjectId {
    /// Generate the UUIDv4 identity used for a newly created project.
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4())
    }

    /// Wrap an existing UUID, for example when loading durable metadata.
    pub const fn from_uuid(uuid: Uuid) -> Self {
        Self(uuid)
    }

    /// Parse the lowercase or uppercase UUID text used at the desktop boundary.
    pub fn parse(value: &str) -> Result<Self, ProjectIdError> {
        Uuid::parse_str(value)
            .map(Self::from_uuid)
            .map_err(|_| ProjectIdError::InvalidUuid)
    }

    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl From<Uuid> for ProjectId {
    fn from(value: Uuid) -> Self {
        Self::from_uuid(value)
    }
}

impl FromStr for ProjectId {
    type Err = ProjectIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectIdError {
    InvalidUuid,
}

impl fmt::Display for ProjectIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUuid => f.write_str("project ID must be a UUID"),
        }
    }
}

impl std::error::Error for ProjectIdError {}

/// Canonical BCP 47 language tag used by project metadata.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Locale(String);

impl Locale {
    /// Parse, validate and canonicalize a BCP 47 tag.
    ///
    /// Validation happens before canonicalization so malformed duplicate
    /// variants cannot be silently repaired into an accepted locale.
    pub fn parse(value: &str) -> Result<Self, LocaleError> {
        let parsed = LanguageTag::parse(value).map_err(|_| LocaleError::Malformed)?;
        parsed
            .validate()
            .map_err(|_| LocaleError::UnregisteredSubtag)?;
        let canonical = parsed
            .canonicalize()
            .map_err(|_| LocaleError::UnregisteredSubtag)?;
        canonical
            .validate()
            .map_err(|_| LocaleError::UnregisteredSubtag)?;
        Ok(Self(canonical.into_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocaleError {
    Malformed,
    UnregisteredSubtag,
}

impl fmt::Display for LocaleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed => f.write_str("locale is not well-formed BCP 47"),
            Self::UnregisteredSubtag => f.write_str("locale contains an unregistered subtag"),
        }
    }
}

impl std::error::Error for LocaleError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MetadataField {
    DisplayName,
    MetadataRevision,
    SourceLocale,
    TargetLocales,
    TargetLocale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValidationIssue {
    Empty,
    WhitespaceOnly,
    ContainsControl,
    InvalidLocaleSyntax,
    UnregisteredLocale,
    EmptyTargetSet,
    DuplicateLocale,
    InvalidRevision,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MetadataError {
    InvalidInput {
        field: MetadataField,
        reason: ValidationIssue,
    },
    StaleRevision {
        current_revision: u64,
    },
    RevisionOverflow,
}

impl fmt::Display for MetadataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput { field, reason } => {
                write!(f, "invalid {field:?}: {reason:?}")
            }
            Self::StaleRevision { current_revision } => {
                write!(
                    f,
                    "metadata revision is stale; current revision is {current_revision}"
                )
            }
            Self::RevisionOverflow => f.write_str("metadata revision cannot be incremented"),
        }
    }
}

impl std::error::Error for MetadataError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeOutcome {
    Changed,
    Unchanged,
}

impl ChangeOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Changed => "changed",
            Self::Unchanged => "unchanged",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataChange {
    metadata: ProjectMetadata,
    outcome: ChangeOutcome,
}

impl MetadataChange {
    pub fn metadata(&self) -> &ProjectMetadata {
        &self.metadata
    }

    pub fn into_metadata(self) -> ProjectMetadata {
        self.metadata
    }

    pub const fn outcome(&self) -> ChangeOutcome {
        self.outcome
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectMetadata {
    project_id: ProjectId,
    display_name: String,
    source_locale: Locale,
    target_locales: Vec<Locale>,
    metadata_revision: u64,
}

impl ProjectMetadata {
    /// Create metadata with a fresh UUIDv4 and revision 1.
    pub fn create<I, S>(
        display_name: &str,
        source_locale: &str,
        target_locales: I,
    ) -> Result<Self, MetadataError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self::create_with_id(
            ProjectId::new_v4(),
            display_name,
            source_locale,
            target_locales,
        )
    }

    /// Create metadata with a caller-supplied identity for loading and tests.
    pub fn create_with_id<I, S>(
        project_id: ProjectId,
        display_name: &str,
        source_locale: &str,
        target_locales: I,
    ) -> Result<Self, MetadataError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        validate_display_name(display_name)?;
        let source_locale = parse_locale(MetadataField::SourceLocale, source_locale)?;
        let target_locales = canonical_targets(target_locales)?;

        Ok(Self {
            project_id,
            display_name: display_name.to_owned(),
            source_locale,
            target_locales,
            metadata_revision: 1,
        })
    }

    /// Reconstruct validated metadata read from durable storage.
    pub(crate) fn from_persisted<I, S>(
        project_id: ProjectId,
        display_name: &str,
        source_locale: &str,
        target_locales: I,
        metadata_revision: u64,
    ) -> Result<Self, MetadataError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        if metadata_revision == 0 {
            return Err(MetadataError::InvalidInput {
                field: MetadataField::MetadataRevision,
                reason: ValidationIssue::InvalidRevision,
            });
        }

        let mut metadata =
            Self::create_with_id(project_id, display_name, source_locale, target_locales)?;
        metadata.metadata_revision = metadata_revision;
        Ok(metadata)
    }

    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn source_locale(&self) -> &Locale {
        &self.source_locale
    }

    pub fn target_locales(&self) -> &[Locale] {
        &self.target_locales
    }

    pub const fn metadata_revision(&self) -> u64 {
        self.metadata_revision
    }

    /// Rename the project against the revision observed by the caller.
    pub fn rename(
        &self,
        expected_revision: u64,
        display_name: &str,
    ) -> Result<MetadataChange, MetadataError> {
        self.check_revision(expected_revision)?;
        validate_display_name(display_name)?;

        if self.display_name == display_name {
            return Ok(self.unchanged());
        }

        let mut next = self.clone();
        next.display_name = display_name.to_owned();
        next.metadata_revision = self.next_revision()?;
        Ok(Self::changed(next))
    }

    /// Add a target locale against the revision observed by the caller.
    pub fn add_target_locale(
        &self,
        expected_revision: u64,
        locale: &str,
    ) -> Result<MetadataChange, MetadataError> {
        self.check_revision(expected_revision)?;
        let locale = parse_locale(MetadataField::TargetLocale, locale)?;

        if self
            .target_locales
            .iter()
            .any(|existing| existing == &locale)
        {
            return Ok(self.unchanged());
        }

        let mut next = self.clone();
        next.target_locales.push(locale);
        next.target_locales.sort_unstable();
        next.metadata_revision = self.next_revision()?;
        Ok(Self::changed(next))
    }

    fn check_revision(&self, expected_revision: u64) -> Result<(), MetadataError> {
        if self.metadata_revision == expected_revision {
            Ok(())
        } else {
            Err(MetadataError::StaleRevision {
                current_revision: self.metadata_revision,
            })
        }
    }

    fn next_revision(&self) -> Result<u64, MetadataError> {
        self.metadata_revision
            .checked_add(1)
            .ok_or(MetadataError::RevisionOverflow)
    }

    fn unchanged(&self) -> MetadataChange {
        MetadataChange {
            metadata: self.clone(),
            outcome: ChangeOutcome::Unchanged,
        }
    }

    fn changed(metadata: ProjectMetadata) -> MetadataChange {
        MetadataChange {
            metadata,
            outcome: ChangeOutcome::Changed,
        }
    }
}

fn validate_display_name(value: &str) -> Result<(), MetadataError> {
    let reason = if value.is_empty() {
        Some(ValidationIssue::Empty)
    } else if value.chars().any(char::is_control) {
        Some(ValidationIssue::ContainsControl)
    } else if value.chars().all(char::is_whitespace) {
        Some(ValidationIssue::WhitespaceOnly)
    } else {
        None
    };

    reason.map_or(Ok(()), |reason| {
        Err(MetadataError::InvalidInput {
            field: MetadataField::DisplayName,
            reason,
        })
    })
}

fn parse_locale(field: MetadataField, value: &str) -> Result<Locale, MetadataError> {
    Locale::parse(value).map_err(|error| MetadataError::InvalidInput {
        field,
        reason: match error {
            LocaleError::Malformed => ValidationIssue::InvalidLocaleSyntax,
            LocaleError::UnregisteredSubtag => ValidationIssue::UnregisteredLocale,
        },
    })
}

fn canonical_targets<I, S>(target_locales: I) -> Result<Vec<Locale>, MetadataError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut targets = Vec::new();
    for raw_locale in target_locales {
        let locale = parse_locale(MetadataField::TargetLocales, raw_locale.as_ref())?;
        if targets.iter().any(|existing: &Locale| existing == &locale) {
            return Err(MetadataError::InvalidInput {
                field: MetadataField::TargetLocales,
                reason: ValidationIssue::DuplicateLocale,
            });
        }
        targets.push(locale);
    }

    if targets.is_empty() {
        return Err(MetadataError::InvalidInput {
            field: MetadataField::TargetLocales,
            reason: ValidationIssue::EmptyTargetSet,
        });
    }

    targets.sort_unstable_by(|left, right| {
        left.as_str()
            .partial_cmp(right.as_str())
            .unwrap_or(Ordering::Equal)
    });
    Ok(targets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_id() -> ProjectId {
        ProjectId::parse("123e4567-e89b-42d3-a456-426614174000").unwrap()
    }

    #[test]
    fn creates_valid_metadata_with_stable_identity_and_sorted_targets() {
        let project =
            ProjectMetadata::create_with_id(fixed_id(), "  Demo 项目  ", "EN-us", ["ja", "zh-CN"])
                .unwrap();

        assert_eq!(project.project_id(), fixed_id());
        assert_eq!(project.display_name(), "  Demo 项目  ");
        assert_eq!(project.source_locale().as_str(), "en-US");
        assert_eq!(project.target_locales()[0].as_str(), "ja");
        assert_eq!(project.target_locales()[1].as_str(), "zh-CN");
        assert_eq!(project.metadata_revision(), 1);
        assert_eq!(project.project_id().as_uuid().get_version_num(), 4);
    }

    #[test]
    fn retains_the_ten_resolved_locale_oracles() {
        let accepted = [
            ("EN-us", "en-US"),
            ("iw", "he"),
            ("en-Latn", "en"),
            ("x-example", "x-example"),
        ];
        for (input, expected) in accepted {
            assert_eq!(Locale::parse(input).unwrap().as_str(), expected);
        }

        assert_ne!(
            Locale::parse("en").unwrap(),
            Locale::parse("en-US").unwrap()
        );
        assert_ne!(
            Locale::parse("zh-CN").unwrap(),
            Locale::parse("zh-Hans").unwrap()
        );

        for input in ["", "ssss", "en_US", "en--US", "sl-rozaj-rozaj"] {
            assert!(Locale::parse(input).is_err(), "{input} should be rejected");
        }
    }

    #[test]
    fn rejects_invalid_names_and_target_sets_without_repairing_input() {
        for (input, reason) in [
            ("", ValidationIssue::Empty),
            (" \u{2003} ", ValidationIssue::WhitespaceOnly),
            ("Demo\nB", ValidationIssue::ContainsControl),
        ] {
            assert_eq!(
                ProjectMetadata::create_with_id(fixed_id(), input, "en-US", ["zh-CN"]),
                Err(MetadataError::InvalidInput {
                    field: MetadataField::DisplayName,
                    reason,
                })
            );
        }

        assert_eq!(
            ProjectMetadata::create_with_id(fixed_id(), "Demo", "en-US", [] as [&str; 0]),
            Err(MetadataError::InvalidInput {
                field: MetadataField::TargetLocales,
                reason: ValidationIssue::EmptyTargetSet,
            })
        );
        assert_eq!(
            ProjectMetadata::create_with_id(fixed_id(), "Demo", "en-US", ["EN-us", "en-US"]),
            Err(MetadataError::InvalidInput {
                field: MetadataField::TargetLocales,
                reason: ValidationIssue::DuplicateLocale,
            })
        );

        let source_equal = ProjectMetadata::create_with_id(fixed_id(), "Demo", "en-US", ["en-US"]);
        assert!(source_equal.is_ok());
    }

    #[test]
    fn rename_preserves_identity_and_obeys_revision_and_noop_rules() {
        let project =
            ProjectMetadata::create_with_id(fixed_id(), "Demo", "en-US", ["zh-CN"]).unwrap();

        let renamed = project.rename(1, "Demo B").unwrap();
        assert_eq!(renamed.outcome(), ChangeOutcome::Changed);
        assert_eq!(renamed.metadata().project_id(), fixed_id());
        assert_eq!(renamed.metadata().display_name(), "Demo B");
        assert_eq!(renamed.metadata().metadata_revision(), 2);

        let unchanged = renamed.metadata().rename(2, "Demo B").unwrap();
        assert_eq!(unchanged.outcome(), ChangeOutcome::Unchanged);
        assert_eq!(unchanged.metadata().metadata_revision(), 2);

        assert_eq!(
            renamed.metadata().rename(1, "Demo B"),
            Err(MetadataError::StaleRevision {
                current_revision: 2,
            })
        );
    }

    #[test]
    fn add_target_is_deterministic_and_existing_targets_are_explicit_noops() {
        let project =
            ProjectMetadata::create_with_id(fixed_id(), "Demo", "en-US", ["zh-CN"]).unwrap();

        let added = project.add_target_locale(1, "JA").unwrap();
        assert_eq!(added.outcome(), ChangeOutcome::Changed);
        assert_eq!(added.metadata().metadata_revision(), 2);
        assert_eq!(
            added
                .metadata()
                .target_locales()
                .iter()
                .map(Locale::as_str)
                .collect::<Vec<_>>(),
            vec!["ja", "zh-CN"]
        );

        let unchanged = added.metadata().add_target_locale(2, "zh-cn").unwrap();
        assert_eq!(unchanged.outcome(), ChangeOutcome::Unchanged);
        assert_eq!(unchanged.metadata().metadata_revision(), 2);

        assert_eq!(
            added.metadata().add_target_locale(1, "zh-cn"),
            Err(MetadataError::StaleRevision {
                current_revision: 2,
            })
        );
    }

    #[test]
    fn revision_overflow_is_rejected_without_mutation() {
        let project = ProjectMetadata {
            project_id: fixed_id(),
            display_name: "Demo".to_owned(),
            source_locale: Locale::parse("en-US").unwrap(),
            target_locales: vec![Locale::parse("zh-CN").unwrap()],
            metadata_revision: u64::MAX,
        };

        assert_eq!(
            project.rename(u64::MAX, "Demo B"),
            Err(MetadataError::RevisionOverflow)
        );
        assert_eq!(project.display_name(), "Demo");
        assert_eq!(project.metadata_revision(), u64::MAX);
    }
}
