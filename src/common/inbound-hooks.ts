/**
 * M8: guest WhatsApp messages that another module answers before the guest
 * inbox (concierge quote replies "YES" / "NO"). A module-level registry keeps
 * the inbox free of that dependency, like stay hooks and domain events.
 */
export interface InboundReply {
  tenantId: string;
  /** Free text sent back to the guest (they just wrote, so the 24-hour window is open). */
  reply: string;
}

export type InboundReplyHook = (m: { digits: string; text: string }) => Promise<InboundReply | null>;

const hooks = new Map<string, InboundReplyHook>();

export function registerInboundReplyHook(name: string, hook: InboundReplyHook): void {
  hooks.set(name, hook);
}

/** The first hook that handles the message wins; null = not handled (goes to the inbox). */
export async function runInboundReplyHooks(m: { digits: string; text: string }): Promise<InboundReply | null> {
  for (const h of hooks.values()) {
    const r = await h(m);
    if (r) return r;
  }
  return null;
}
