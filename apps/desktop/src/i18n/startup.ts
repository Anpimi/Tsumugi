export const startupEn = {
  manual: "Create a project manually…", title: "New project", help: "Choose the project location and languages. Importing content is a separate step after creation.",
  name: "Project name", parent: "Save in", folder: "New folder name", chooseParent: "Choose a folder…", destination: "Project folder", locationHelp: "A new subfolder will be created here. Existing folders are kept.",
  source: "Source language", sourceHelp: "Confirm the language of the original text. It cannot be changed after creation.",
  target: "Add a target language", targets: "Target languages", addTarget: "Add language", removeTarget: "Remove {{language}}", noTargets: "Add at least one target language.",
  create: "Create project", close: "Close", required: "Fill in this field.", invalidFolder: "Use one new folder name without slashes or reserved characters.", duplicateTarget: "This language is already in the list.", invalidField: "Check this value and try again.",
  pickFailed: "Could not open the folder chooser. Try again or enter the location.", createFailed: "Creation did not complete. Your settings are kept; check the location and details below.",
  unknown: "The project may have been created. Open the original destination to check before trying to create it again.", openDestination: "Open the project folder", unknownLocation: "Original destination: {{path}}",
  discardTitle: "Discard new project settings?", discardHelp: "Only these unsaved settings will be discarded. Existing projects are kept.", discardExit: "The project has not been created. Discard these settings and exit the app?", keep: "Keep editing", discard: "Discard settings", changed: "The settings changed while you were reviewing them. Review the new values before continuing.",
} as const;

export const startupZh = {
  manual: "手动新建…", title: "新建项目", help: "选好存放位置和语言，再创建项目。导入内容是之后的单独一步。",
  name: "项目名称", parent: "存放位置", folder: "新文件夹名称", chooseParent: "选择文件夹…", destination: "项目文件夹", locationHelp: "将在这里新建一个子文件夹，不覆盖已有文件夹。",
  source: "源语言", sourceHelp: "请确认原文使用的语言，项目创建后不能更改。",
  target: "添加目标语言", targets: "目标语言", addTarget: "添加语言", removeTarget: "移除{{language}}", noTargets: "请至少添加一种目标语言。",
  create: "创建项目", close: "关闭", required: "请填写这一项。", invalidFolder: "请填写一个新文件夹名称，不要包含斜杠或保留字符。", duplicateTarget: "列表中已有这种语言。", invalidField: "请检查这一项后重试。",
  pickFailed: "没能打开文件夹选择器。可以重试，也可以填写位置。", createFailed: "创建没有完成，填写的信息已保留。请检查存放位置和下方详情。",
  unknown: "还不能确认项目是否已创建。请先打开原目标文件夹核对，不要重复创建。", openDestination: "打开项目文件夹", unknownLocation: "原目标位置：{{path}}",
  discardTitle: "放弃新建设置？", discardHelp: "只会放弃这些尚未保存的设置，已有项目会保留。", discardExit: "项目还没有创建。放弃这些设置并退出应用？", keep: "继续填写", discard: "放弃设置", changed: "核对期间设置又有变化，请先查看新内容再继续。",
} as const;
