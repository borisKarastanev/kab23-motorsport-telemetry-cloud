/**
 * A user's role *within one team*, stored on `team_members`.
 *
 * Deliberately separate from `UserRole`, which is platform-wide: the same
 * person can own one team and merely drive for another, and neither fact says
 * anything about their standing on the platform.
 */
export enum TeamRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  DRIVER = 'DRIVER',
}

/**
 * Roles that may administer a team's roster and its cars. Declared beside the
 * enum so adding a role is a one-file decision — teams, cars, and sessions all
 * gate on this same list.
 */
export const MANAGING_TEAM_ROLES = [TeamRole.OWNER, TeamRole.MANAGER];
