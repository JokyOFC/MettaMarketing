import { randomBytes } from "node:crypto";

// prefix_ + 16 base64url chars (96 random bits). Prefixes: usr cli brd prj tsk
// cmp cat upl mat ver fil col fnt kit cmt apr rel zip dle brf ntf eml ord sub
// pay whk ses svc.
export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

// Opaque random token for links sent by e-mail or cookies (256 bits).
export function newToken() {
  return randomBytes(32).toString("base64url");
}

export const ID_PATTERN = /^[a-z]{3}_[A-Za-z0-9_-]{16}$/;
