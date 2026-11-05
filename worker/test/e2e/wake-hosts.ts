/**
 * The local journeys' Omnigent hosts for the setup page's wake (WP3.53), shared by the e2e
 * platform Worker's fake Omnigent (`platform-e2e.ts`) and the journeys (`journeys.ts`). Each wake
 * journey's computer has its own host, so the fake Omnigent can tell them apart. Synthetic values.
 */

/** The fake Omnigent's session cookie: without it, Omnigent answers 401, as when signed out. */
export const OMNIGENT_SESSION_COOKIE = "e2e_omnigent_session";

/** An asleep computer of the owner's: the sign-in and terminal journeys wake it. */
export const ASLEEP_HOST = "a5".repeat(16);
/** An asleep computer of the owner's whose wake Omnigent reports as failed, with its reason. */
export const FULL_HOST = "f0".repeat(16);
/** An asleep computer of someone else's: Omnigent refuses the owner's call to wake it. */
export const OTHERS_HOST = "0e".repeat(16);

/** The reason Omnigent gives for FULL_HOST, with markup in it that must show as text. */
export const FULL_REASON =
  "Work computer could not wake: All computers are busy: the installation's limit of awake computers is reached. <b>not markup</b>";

/** The other person's Access subject. */
export const OTHER_SUB = "00000000-0000-4000-8000-0000000000ff";

/**
 * WP8.15: an asleep computer of a team member's, bound to that member. The journeys' browser is
 * the installation's owner, an administrator here, who manages it from its page; the fake
 * Omnigent lets that administrator wake it, as the fork's `may_manage_host` does.
 */
export const MEMBER_HOST = "3e".repeat(16);
/** The member's Access subject, Omnigent account, team member ID and team ID. Synthetic. */
export const MEMBER_SUB = "00000000-0000-4000-8000-0000000000aa";
export const MEMBER_ACCOUNT = "e2e-member";
export const MEMBER_ID = "3e3e3e3e3e3e4e3e8e3e3e3e3e3e3e3e";
export const MEMBER_TEAM = "7e7e7e7e7e7e4e7e8e7e7e7e7e7e7e7e";
