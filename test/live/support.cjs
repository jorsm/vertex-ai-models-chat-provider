const { randomInt } = require("node:crypto");
const { deflateSync } = require("node:zlib");

const PROVIDERS = [
    "gemini",
    "claude",
];
const FEATURES = [
    "chat",
    "tools",
    "image",
];
const DEFAULTS = {
    project: "",
    expectedAccount: "",
    region: "global",
    models: { gemini: "gemini-3.8-flash", claude: "claude-haiku-5-5" },
    requestTimeoutSeconds: 90,
    hostTimeoutSeconds: 900,
    vscodeVersion: "1.110.0",
};

function safeError(error) {
    return String(error?.message || error)
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/ya29\.[\w.-]+/g, "[REDACTED]")
        .replace(/((?:access_token|refresh_token|id_token|client_secret|private_key)["'\s:=]+)[^\s,"'}]+/gi, "$1[REDACTED]")
        .slice(0, 2500);
}

function completeReport(report) {
    const required = PROVIDERS.flatMap((provider) => FEATURES.map((feature) => `${provider}:${feature}`));
    const keys = report.checks.map((check) => `${check.provider}:${check.feature}`);
    report.releaseEligible = !report.runnerError && report.setup?.status === "passed" && keys.length === required.length && new Set(keys).size === required.length && required.every((key) => keys.includes(key)) && report.checks.every((check) => check.status === "passed");
    report.status = report.releaseEligible ? "passed" : "failed";
    report.completedAt = new Date().toISOString();
    return report;
}

function blockPending(report, reason) {
    for (const provider of PROVIDERS) {
        for (const feature of FEATURES) {
            if (!report.checks.some((check) => check.provider === provider && check.feature === feature)) {
                report.checks.push({ provider, feature, status: "blocked", error: reason });
            }
        }
    }
    return completeReport(report);
}

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(
        crc32(
            Buffer.concat([
                name,
                data,
            ]),
        ),
    );
    return Buffer.concat([
        length,
        name,
        data,
        checksum,
    ]);
}

// Random pixel content makes an omitted image much less likely to pass by guessing.
function makeImageChallenge() {
    const palette = [
        [
            "red",
            [
                230,
                0,
                0,
            ],
        ],
        [
            "green",
            [
                0,
                170,
                0,
            ],
        ],
        [
            "blue",
            [
                0,
                60,
                230,
            ],
        ],
        [
            "yellow",
            [
                255,
                220,
                0,
            ],
        ],
        [
            "purple",
            [
                155,
                0,
                190,
            ],
        ],
    ];
    for (let i = palette.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [
            palette[i],
            palette[j],
        ] = [
            palette[j],
            palette[i],
        ];
    }
    const width = 640;
    const height = 200;
    const pixels = Buffer.alloc(height * (1 + width * 3), 255);
    for (let y = 0; y < height; y++) {
        pixels[y * (1 + width * 3)] = 0;
        for (let i = 0; i < palette.length; i++) {
            for (let x = 20 + i * 124; y >= 40 && y < 160 && x < 120 + i * 124; x++) {
                const offset = y * (1 + width * 3) + 1 + x * 3;
                pixels.set(palette[i][1], offset);
            }
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const png = Buffer.concat([
        Buffer.from([
            137,
            80,
            78,
            71,
            13,
            10,
            26,
            10,
        ]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(pixels)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
    return { png, expected: palette.map(([name]) => name).join(",") };
}

module.exports = { PROVIDERS, FEATURES, DEFAULTS, safeError, completeReport, blockPending, makeImageChallenge };
