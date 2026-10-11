import * as https from "https";
import type { Logger } from "../../utils/Logger";

/**
 * Owns the allowlist used to filter tool schemas before Gemini requests.
 *
 * @remarks
 * Discovery runs in the background on direct-provider initialization. Until a valid
 * discovery document arrives, sanitization uses the built-in allowlist. This object
 * survives provider reinitialization, including its successful discovery state.
 */
export class VertexToolSchema {
    /** Initial allowlist used before successful discovery replaces it. */
    private allowedSchemaKeys = new Set<string>([
        "type",
        "format",
        "description",
        "nullable",
        "enum",
        "properties",
        "required",
        "items",
    ]);
    private discoveryCompleted = false;

    constructor(private readonly logger: Logger) {}

    /**
     * Starts background discovery unless a previous response supplied a nonempty allowlist.
     *
     * @remarks
     * Parse and network errors are logged while retaining the current allowlist. No
     * request timeout or in-flight request coalescing is applied here.
     */
    discoverKeys(): void {
        if (this.discoveryCompleted) {
            return;
        }
        const url = "https://aiplatform.googleapis.com/$discovery/rest?version=v1";
        https
            .get(url, (response) => {
                if (response.statusCode !== 200) {
                    return;
                }
                let data = "";
                response.on("data", (chunk) => (data += chunk));
                response.on("end", () => {
                    try {
                        const doc = JSON.parse(data);
                        const schemaDef = doc.schemas?.GoogleCloudAiplatformV1Schema;
                        if (schemaDef?.properties) {
                            const keys = Object.keys(schemaDef.properties);
                            if (keys.length > 0) {
                                this.allowedSchemaKeys = new Set(keys);
                                this.discoveryCompleted = true;
                                this.logger.log(`🌐 Vertex Schema Discovery completed: populated ${keys.length} allowed properties. ${JSON.stringify(keys)}`);
                            }
                        }
                    } catch (e) {
                        this.logger.log(`⚠️ Vertex Schema Discovery parse error, falling back to safe list: ${e}`);
                    }
                });
            })
            .on("error", (e) => {
                this.logger.log(`⚠️ Vertex Schema Discovery network error, falling back to safe list: ${e}`);
            });
    }

    /**
     * Recursively copies supported schema keywords while preserving property names.
     *
     * @param schema - Schema data to filter. Primitives are returned unchanged.
     * @param isPropertiesMap - Whether keys at this level represent argument names.
     * @returns Filtered objects and arrays using the current discovery allowlist.
     *
     * @remarks
     * This is an allowlist filter rather than complete schema validation. Object keys
     * below `properties` are retained; their values are filtered as schemas.
     */
    sanitize(schema: any, isPropertiesMap = false): any {
        if (!schema || typeof schema !== "object") {
            return schema;
        }
        if (Array.isArray(schema)) {
            return schema.map((item) => this.sanitize(item));
        }

        const result: any = {};
        for (const [
            key,
            value,
        ] of Object.entries(schema)) {
            if (isPropertiesMap) {
                // The keys here are tool argument names, keep them as is and sanitize their schemas
                result[key] = this.sanitize(value, false);
            } else {
                // Only strictly allow keys natively supported by Google's API Open API 3.0 schema representation
                if (this.allowedSchemaKeys.has(key)) {
                    result[key] = this.sanitize(value, key === "properties");
                }
            }
        }
        return result;
    }
}
