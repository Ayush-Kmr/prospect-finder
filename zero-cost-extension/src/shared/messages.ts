import type { Identity } from '../services/identity';

export interface ManualInput { name: string; company: string; title?: string; linkedinUrl?: string }

/** Work to resume after the user grants a site permission (the prompt may close the popup). */
export type PendingAction =
  | { kind: 'scan'; origins: string[]; identity: Identity; website: string | null }
  | { kind: 'analyzeUrl'; origins: string[]; url: string };

export type Msg =
  | { type: 'readProfile'; tabId: number }
  | { type: 'saveIdentity'; identity: Identity }
  | { type: 'find'; identity?: Identity; manual?: ManualInput; website?: string | null }
  | { type: 'analyzeTab'; tabId: number }
  | { type: 'analyzeTabs'; windowId: number }
  | { type: 'analyzeUrl'; url: string }
  | { type: 'setPending'; pending: PendingAction | null }
  | { type: 'cancel' }
  | { type: 'clear' };

export type Reply =
  | { ok: true; identity?: Identity; found?: number; analyzed?: number; skipped?: number }
  | { ok: false; error: string; code?: 'not-profile' | 'no-lookup' | 'no-permission' | 'unreadable' };

export function send(msg: Msg): Promise<Reply> {
  return chrome.runtime.sendMessage(msg);
}
