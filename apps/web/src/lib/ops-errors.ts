/**
 * The refusal an admin support operation answers with 400, naming the field
 * at fault. Dependency-free so any store can throw it without importing
 * admin-ops-store (password-reset.ts does, and admin-ops-store must stay free
 * to import from it). admin-ops-store re-exports it.
 */
export class OpsValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "OpsValidationError";
    this.field = field;
  }
}
