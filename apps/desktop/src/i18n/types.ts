export interface UiMessages {
  brandDescription: string;
  nav: {
    workspace: string;
    translations: string;
    glossary: string;
    quality: string;
    settings: string;
  };
  future: string;
  menu: { file: string; edit: string; view: string; help: string };
  language: string;
  languageEnglish: string;
  languageChinese: string;
  empty: {
    title: string;
    body: string;
    detail: string;
    create: string;
    open: string;
  };
  create: {
    title: string;
    intro: string;
    destination: string;
    destinationPlaceholder: string;
    destinationHelp: string;
    displayName: string;
    displayNamePlaceholder: string;
    sourceLocale: string;
    sourceLocalePlaceholder: string;
    targetLocales: string;
    targetLocalesPlaceholder: string;
    targetLocalesHelp: string;
    submit: string;
  };
  open: {
    title: string;
    intro: string;
    destination: string;
    destinationPlaceholder: string;
    destinationHelp: string;
    submit: string;
  };
  project: {
    eyebrow: string;
    source: string;
    targets: string;
    revision: string;
    identity: string;
    noTargets: string;
    openAnother: string;
    close: string;
    rename: string;
    addTarget: string;
    showOpen: string;
  };
  editor: {
    renameTitle: string;
    renameLabel: string;
    renameHelp: string;
    targetTitle: string;
    targetLabel: string;
    targetHelp: string;
    basis: string;
    save: string;
    cancel: string;
  };
  status: {
    ready: string;
    opening: string;
    saving: string;
    reconciling: string;
    closing: string;
    unsaved: string;
    conflict: string;
  };
  action: {
    cancel: string;
    discard: string;
    saveAndContinue: string;
    retry: string;
    refresh: string;
    dismiss: string;
  };
  dialog: {
    title: string;
    message: string;
    closeMessage: string;
    openMessage: string;
    formMessage: string;
  };
  feedback: {
    created: string;
    opened: string;
    renamed: string;
    targetAdded: string;
    unchanged: string;
    closed: string;
    stale: string;
    staleRefreshFailed: string;
    unknown: string;
    committed: string;
    previous: string;
    reconcileFailed: string;
    savedBeforeContinue: string;
  };
  errors: {
    invalidInput: string;
    destinationConflict: string;
    missingProject: string;
    permissionDenied: string;
    unsupportedSchema: string;
    corruptProject: string;
    sessionInvalid: string;
    projectInUse: string;
    busy: string;
    storageFailed: string;
    outcomeUnknown: string;
    unknown: string;
  };
  accessibility: { projectActions: string; metadata: string; feedback: string };
}
