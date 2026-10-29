/**
 * Auth interaction shapes. OAuth/OIDC/PKCE live in provider-auth; adopt
 * helpers stay with the connection registry (D3).
 */
import { AUTH_INTERACTION_KINDS } from "./schemas/provider.js";

export type AuthInteractionKind = (typeof AUTH_INTERACTION_KINDS)[number];
export type AuthInteraction = {
  readonly kind: AuthInteractionKind;
  readonly connectionId: string;
};
