import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";
import type { Logger } from "../../utils/Logger";

/**
 * Creates a direct Vertex OpenAI-compatible client with a fresh Google access token.
 *
 * Explicit credentials take precedence over a key filename; otherwise GoogleAuth
 * uses its default credential discovery. The OpenAI SDK retains its default retry
 * policy. The caller supplies the fetch adapter used to normalize Vertex streams.
 *
 * @throws When GoogleAuth cannot produce an access token.
 */
export async function createGrokClient(projectId: string, region: string, authOptions: any, logger: Logger, fetchStream: (url: RequestInfo, init?: RequestInit) => Promise<Response>): Promise<OpenAI> {
    const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
    const baseURL = `https://${host}/v1/projects/${projectId}/locations/${region}/endpoints/openapi`;

    let googleAuth: GoogleAuth;
    if (authOptions?.credentials) {
        googleAuth = new GoogleAuth({
            credentials: authOptions.credentials,
            scopes: "https://www.googleapis.com/auth/cloud-platform",
        });
    } else if (authOptions?.keyFilename) {
        googleAuth = new GoogleAuth({
            keyFilename: authOptions.keyFilename,
            scopes: "https://www.googleapis.com/auth/cloud-platform",
        });
    } else {
        googleAuth = new GoogleAuth({
            scopes: "https://www.googleapis.com/auth/cloud-platform",
        });
    }

    const accessToken = await googleAuth.getAccessToken();
    if (!accessToken) {
        throw new Error("Failed to obtain Google Cloud access token");
    }

    logger.log(`  🔑 Fresh token obtained, baseURL=${baseURL}`);
    return new OpenAI({
        baseURL,
        apiKey: accessToken,
        fetch: async (url, init) => fetchStream(url as unknown as RequestInfo, init as unknown as RequestInit) as any,
    });
}

/**
 * Removes Vertex's non-JSON `data: : keepalive` lines before SDK SSE parsing.
 *
 * Lines may span network chunks. Other decoded lines and response metadata are
 * retained; responses without an SSE body pass through unchanged.
 */
export function filterMalformedKeepaliveEvents(response: Response): Response {
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffered = "";
    const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                buffered += decoder.decode(chunk, { stream: true });
                const lines = buffered.split("\n");
                buffered = lines.pop() ?? "";
                for (const line of lines) {
                    if (!/^data:\s*:\s*keepalive\s*$/i.test(line)) {
                        controller.enqueue(encoder.encode(`${line}\n`));
                    }
                }
            },
            flush(controller) {
                buffered += decoder.decode();
                if (buffered.length > 0 && !/^data:\s*:\s*keepalive\s*$/i.test(buffered)) {
                    controller.enqueue(encoder.encode(buffered));
                }
            },
        }),
    );

    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
