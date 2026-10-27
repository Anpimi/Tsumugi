import type { StatusGlyphState } from "../../design-system/StatusGlyph";

// Display fixtures only. These records never enter a project or an action ledger.
export const sampleEntries: {
  id: number; key: string; source: string; target: string;
  state: StatusGlyphState; protected?: boolean;
  facts: readonly ["confirmedVersion" | "notSelected", "reviewed" | "notReviewed", "checksPassed" | "checksFailed" | "notChecked", "currentSource" | "sourceUpdated"];
}[] = [
  { id: 97, key: "dialogue.lewis.welcome", source: "Welcome back, {{name}}! It’s good to see you in Pelican Town again.", target: "欢迎回来，{{name}}！很高兴再次在鹈鹕镇见到你。", state: "translated", facts: ["confirmedVersion", "notReviewed", "notChecked", "currentSource"] },
  { id: 98, key: "dialogue.lewis.invitation", source: "My friend, I hope you’ll join us beneath the old oak tree when the evening bells begin to ring.", target: "朋友，暮钟响起时，希望你能到老橡树下与我们相聚。", state: "candidate", facts: ["notSelected", "notReviewed", "notChecked", "currentSource"] },
  { id: 99, key: "dialogue.festival.start", source: "The harvest festival begins tomorrow. Bring something you’ve grown, and we’ll make a feast to remember.", target: "丰收节明天开始。带上你亲手种的东西，我们一起办一场难忘的盛宴。", state: "draft", facts: ["notSelected", "notReviewed", "notChecked", "currentSource"] },
  { id: 100, key: "inventory.items.count", source: "You have {{count}} items.\nChoose an item to give to {{name}}.", target: "你有 {{count}} 个物品。\n选择一件送给 {{name}}。", state: "blocked", facts: ["confirmedVersion", "notReviewed", "checksFailed", "currentSource"] },
  { id: 101, key: "dialogue.robin.workshop", source: "The workshop will be closed on Thursday, but I can still leave your order by the front door.", target: "工坊周四不开门，不过我可以把你订的东西放在门前。", state: "reviewed", protected: true, facts: ["confirmedVersion", "reviewed", "checksPassed", "currentSource"] },
  { id: 102, key: "mail.festival.weather", source: "If the rain continues, meet us inside the community center instead. <em>Please keep this note.</em>", target: "如果雨一直下，就改在社区中心见面。<em>请保留这张便条。</em>", state: "stale", facts: ["confirmedVersion", "notReviewed", "notChecked", "sourceUpdated"] },
  { id: 103, key: "dialogue.mariner.farewell", source: "A fair wind to you, traveler. May your stories find a home wherever the tide takes you.", target: "", state: "untranslated", facts: ["notSelected", "notReviewed", "notChecked", "currentSource"] },
  { id: 104, key: "dialogue.museum.donation", source: "Every little discovery tells us something about the valley. Thank you for sharing yours.", target: "每一份小小的发现，都能让我们多了解山谷一些。谢谢你愿意分享。", state: "translated", facts: ["confirmedVersion", "notReviewed", "notChecked", "currentSource"] },
];
