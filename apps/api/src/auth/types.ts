export type Role = 'requester' | 'helpdesk' | 'approver';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    sessionTokenHash?: string;
    uiEmail?: string;
  }
}
