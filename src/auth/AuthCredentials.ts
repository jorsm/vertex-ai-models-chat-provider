import * as vscode from "vscode";
import { GCLOUD_DEFAULT_TIMEOUT_MS } from "../utils/gcloud";

/** Supported sources for authenticating Vertex AI requests. */
export type AuthMethodType = "secret" | "file" | "adc";

/** Maximum number of retries after a gcloud CLI command times out. */
export const GCLOUD_MAX_TIMEOUT_RETRIES = 3;

/** Allow process termination and completion overhead around the CLI attempts. */
const PROXY_AUTHENTICATION_OVERHEAD_MS = 10_000;
/** Five minutes is the longest supported timeout for one noninteractive CLI attempt. */
const GCLOUD_MAX_TIMEOUT_SECONDS = 5 * 60;

/** Reads the per-attempt CLI timeout, falling back to 20 seconds for invalid settings. */
export function getConfiguredGcloudTimeoutMs(): number {
    const seconds = vscode.workspace?.getConfiguration?.("vertexAiChat")?.get<unknown>("gcloudCommandTimeoutSeconds", GCLOUD_DEFAULT_TIMEOUT_MS / 1000);
    if (typeof seconds !== "number" || !Number.isInteger(seconds)) {
        return GCLOUD_DEFAULT_TIMEOUT_MS;
    }
    if (seconds < 1 || seconds > GCLOUD_MAX_TIMEOUT_SECONDS) {
        return GCLOUD_DEFAULT_TIMEOUT_MS;
    }
    return seconds * 1000;
}

/**
 * Bounds discovery's wait for a proxy ID token independently of its HTTP timeout.
 *
 * @remarks
 * Includes the initial CLI attempt, timeout retries, and completion overhead.
 * Waiting in the shared CLI queue consumes this allowance too. The five-minute
 * per-attempt limit keeps the combined allowance within Node's timer range.
 */
export function getProxyAuthenticationTimeoutMs(): number {
    const attempts = 1 + GCLOUD_MAX_TIMEOUT_RETRIES;
    return attempts * getConfiguredGcloudTimeoutMs() + PROXY_AUTHENTICATION_OVERHEAD_MS;
}

/**
 * Describes the authentication source selected for the current workspace.
 *
 * @remarks
 * `value` is a stored Service Account name for `secret`, a credential path for
 * `file`, and unused for `adc`.
 */
export interface AuthMethod {
    type: AuthMethodType;
    value?: string;
}

/**
 * Google authentication options passed to the Vertex AI client.
 *
 * @remarks
 * An undefined result from direct credential resolution means to use ADC.
 * Credential fields remain unknown until the caller or Google auth client validates them.
 */
export interface AuthOptions {
    /** Parsed Google credential document, including Service Account or other file-based formats. */
    credentials?: Record<string, unknown>;
    /** Path to the Google credential JSON file, when credentials are read from disk. */
    keyFilename?: string;
    /** Project associated with the selected credentials, when available. */
    projectId?: string;
}

/** Required identity and key fields validated before a Service Account credential is stored. */
export interface ServiceAccountCredentials extends Record<string, unknown> {
    type: "service_account";
    project_id: string;
    client_email: string;
    private_key: string;
}

/**
 * Raised when a workspace's explicitly selected credential is unavailable or invalid.
 *
 * @remarks
 * This error preserves explicit credential selection instead of allowing fallback to ambient ADC.
 */
export class AuthConfigurationError extends Error {
    /**
     * Creates an error for a credential that cannot be resolved as selected.
     *
     * @param message - User-facing explanation of the authentication configuration problem.
     */
    constructor(message: string) {
        super(message);
        this.name = "AuthConfigurationError";
    }
}

/**
 * Parses credential JSON without exposing its contents in parser diagnostics.
 *
 * @param json - Credential document read from SecretStorage or a credential file.
 * @returns A credential object preserving additional Google auth fields.
 * @throws A sanitized error if the JSON is malformed or does not contain an object.
 */
export function parseCredentialJson(json: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("Invalid JSON format");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Credential JSON must contain an object");
    }
    return parsed as Record<string, unknown>;
}

/**
 * Validates the Service Account fields required before storing or using a selected secret.
 *
 * @param json - Raw Service Account JSON.
 * @returns Credentials containing a non-empty project, client email, and private key.
 * @throws A sanitized error if the document is malformed or required fields are missing.
 */
export function parseServiceAccount(json: string): ServiceAccountCredentials {
    const credentials = parseCredentialJson(json);
    if (credentials.type !== "service_account") {
        throw new Error("Not a valid service account JSON (missing type: service_account)");
    }
    if (typeof credentials.project_id !== "string" || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string" || !credentials.project_id || !credentials.client_email || !credentials.private_key) {
        throw new Error("Service account JSON is missing project_id, client_email, or private_key");
    }
    return credentials as ServiceAccountCredentials;
}
