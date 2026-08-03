export type UserRole = 'DRIVER' | 'MANAGER' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  displayName?: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}
