import { createContext, useContext } from "react";

export interface ConversationMemberRoute {
  key: string;
  name: string;
  plan: string;
  current: () => boolean;
  open: (body?: string) => void;
}
export function composerMemberRoute(text: string, routes: readonly ConversationMemberRoute[]) {
  const input = text.trimStart();
  const matches = routes.filter(route => {
    const prefix = `@${route.name}`;
    return input.startsWith(prefix) && (input.length === prefix.length || /\s/u.test(input[prefix.length])) && route.current();
  });
  if (matches.length !== 1) return null;
  return { route: matches[0], body: input.slice(matches[0].name.length + 1).trimStart() };
}
/** Transient routes to mounted typed guidance editors, never a second roster or history. */
export const ConversationMemberRoutes = createContext<{
  register: (key: string, routes: readonly ConversationMemberRoute[]) => () => void;
} | null>(null);
export const useConversationMemberRoutes = () => useContext(ConversationMemberRoutes);
