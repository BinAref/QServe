/**
 * A second sign-in, asking the first for permission.
 *
 * One account signed in twice is how a cashier's till ends up being operated
 * from the back office while the cashier is at the counter, and it is how an
 * audit trail quietly stops meaning anything: two people, one name, one log.
 * Every action in this product records who did it, and that record is only
 * worth keeping if "who" is one person.
 *
 * So the second sign-in does not win and does not simply lose. It asks. The
 * person already signed in is shown who is asking and from where, and told
 * plainly that saying yes signs them out. Saying nothing is saying no.
 *
 * Held in memory on purpose. A request is a question somebody is standing in
 * front of waiting for an answer to; if the server restarts mid-question there
 * is nobody left to answer it, and a request that outlived the process would
 * be a stale approval waiting to be used.
 */

import { randomBytes } from 'node:crypto';

/** Long enough that nobody is rushed, short enough that nobody is stuck. */
const ANSWER_WINDOW_MS = 60_000;

export type LoginRequestState = 'waiting' | 'approved' | 'denied' | 'expired';

export interface LoginRequest {
  readonly id: string;
  readonly userId: string;
  readonly userName: string;
  /** What the person being asked is shown: where the request came from. */
  readonly fromIp: string;
  readonly fromTerminalName: string | null;
  readonly askedAt: number;
  state: LoginRequestState;
}

export interface PublicLoginRequest {
  readonly id: string;
  readonly userName: string;
  readonly fromIp: string;
  readonly fromTerminalName: string | null;
  readonly expiresInSeconds: number;
}

export class LoginRequests {

  private readonly waiting = new Map<string, LoginRequest>();

  /**
   * Ask. Returns the request the second device will wait on and the first
   * device will be shown.
   */
  open(input: {
    userId: string;
    userName: string;
    fromIp: string;
    fromTerminalName: string | null;
  }): LoginRequest {
    this.sweep();

    /*
     * One question at a time per account.
     *
     * Two devices trying at once would otherwise put two dialogs on the
     * incumbent's screen, and answering one would leave the other standing.
     * The newer attempt replaces the older, which is also the more likely to
     * still have somebody in front of it.
     */
    for (const [id, request] of this.waiting) {
      if (request.userId === input.userId && request.state === 'waiting') {
        request.state = 'denied';
        this.waiting.delete(id);
      }
    }

    const request: LoginRequest = {
      id: randomBytes(18).toString('base64url'),
      userId: input.userId,
      userName: input.userName,
      fromIp: input.fromIp,
      fromTerminalName: input.fromTerminalName,
      askedAt: Date.now(),
      state: 'waiting',
    };
    this.waiting.set(request.id, request);
    return request;
  }

  /** What the second device polls. Unknown ids read as expired, not as an error. */
  state(id: string): LoginRequestState {
    this.sweep();
    return this.waiting.get(id)?.state ?? 'expired';
  }

  get(id: string): LoginRequest | undefined {
    this.sweep();
    return this.waiting.get(id);
  }

  /** Every unanswered question for this account, for a screen that just loaded. */
  pendingFor(userId: string): PublicLoginRequest[] {
    this.sweep();
    return [...this.waiting.values()]
      .filter((request) => request.userId === userId && request.state === 'waiting')
      .map((request) => this.publicView(request));
  }

  publicView(request: LoginRequest): PublicLoginRequest {
    const left = ANSWER_WINDOW_MS - (Date.now() - request.askedAt);
    return {
      id: request.id,
      userName: request.userName,
      fromIp: request.fromIp,
      fromTerminalName: request.fromTerminalName,
      expiresInSeconds: Math.max(0, Math.round(left / 1000)),
    };
  }

  /**
   * Answer one. Only the account being asked about may answer, which is checked
   * here rather than trusted from the route: an id is a guessable-looking string
   * and this is the door it opens.
   */
  answer(id: string, byUserId: string, approve: boolean): LoginRequestState | null {
    this.sweep();
    const request = this.waiting.get(id);
    if (!request || request.state !== 'waiting') return null;
    if (request.userId !== byUserId) return null;

    request.state = approve ? 'approved' : 'denied';
    return request.state;
  }

  /** Taken once. An approval that could be replayed is an approval for anybody. */
  claim(id: string): LoginRequest | null {
    this.sweep();
    const request = this.waiting.get(id);
    if (!request || request.state !== 'approved') return null;
    this.waiting.delete(id);
    return request;
  }

  private sweep(): void {
    const cutoff = Date.now() - ANSWER_WINDOW_MS;
    for (const [id, request] of this.waiting) {
      // A denial is kept just long enough for the asker's next poll to see it,
      // so the second device is told "no" rather than "that request is gone".
      const stale = request.askedAt < cutoff;
      if (stale) this.waiting.delete(id);
    }
  }
}
