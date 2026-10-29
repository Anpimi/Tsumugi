export const projectBriefEn = {
  title: "Project brief", help: "Project records only. No model is called to prepare this brief.",
  loading: "Reading project progress…", empty: "This project has no source entries yet. Import source content to begin.",
  noLanguages: "Add a target language before viewing translation progress.",
  progress: "Selected translations: {{selected, number}} / {{total, number}}", progressLabel: "Selected translations in {{locale}}",
  progressUnknown: "Translation progress is not available.", selectionUnknown: "{{total, number}} source entries; selected translation count is not available.",
  blocking: "Entries blocking delivery: {{count, number}}", blockingUnknown: "Delivery blocker count is not available.",
  decisions: "Waiting for your decision: {{count, number}}", decisionsPartial: "At least {{count, number}} decisions are waiting; some sources are incomplete.",
  decisionsLoading: "Reading decisions…", decisionsFailed: "Decisions could not be read.", decisionsUnknown: "The number of waiting decisions is not known.",
  reviewSeparate: "Selected translations still need their own review and checks. Selection does not mean approval or readiness for delivery.",
  partial: "Some counts could not be read together. Available counts are kept; refresh to check the rest.", refresh: "Refresh project counts",
  continue: "Continue {{entry}} · {{locale}}", entries: "Open entries", import: "Import source content", openDecisions: "Review waiting decisions",
};

export const projectBriefZh: typeof projectBriefEn = {
  title: "项目简报", help: "仅使用项目记录生成，不调用模型。",
  loading: "正在读取项目进度…", empty: "项目尚无源条目。导入源内容后即可开始。",
  noLanguages: "添加目标语言后即可查看翻译进度。",
  progress: "已选译文：{{selected, number}} / {{total, number}}", progressLabel: "{{locale}}的已选译文",
  progressUnknown: "翻译进度暂不可用。", selectionUnknown: "共 {{total, number}} 条源条目；已选译文数量暂不可用。",
  blocking: "阻塞交付的条目：{{count, number}}", blockingUnknown: "阻塞交付的数量暂不可用。",
  decisions: "待你决定：{{count, number}} 项", decisionsPartial: "至少有 {{count, number}} 项待你决定；部分来源尚未读全。",
  decisionsLoading: "正在读取待决定事项…", decisionsFailed: "无法读取待决定事项。", decisionsUnknown: "待决定事项数量尚不明确。",
  reviewSeparate: "已选译文仍需单独审阅和检查。选用不代表审阅通过或可以交付。",
  partial: "部分数量无法在同一依据下读全。已读数量保留，可刷新核对其余数量。", refresh: "刷新项目数量",
  continue: "继续 {{entry}} · {{locale}}", entries: "打开条目", import: "导入源内容", openDecisions: "查看待决定事项",
};
