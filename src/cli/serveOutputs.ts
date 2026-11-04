// Serves the files of OUTPUT_DIR over HTTP, so results can be downloaded from the Railway
// service (railway volume files needs SSH, which some networks block).
// Every request needs ?key=<DOWNLOAD_KEY>. GET / lists the files, GET /<file> downloads one.
import * as fs from "fs";
import * as http from "http";
import path from "path";

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, "../../output");
const KEY = process.env.DOWNLOAD_KEY;
const PORT = Number(process.env.PORT) || 8080;

if (!KEY || KEY.length < 16) {
    console.error("DOWNLOAD_KEY must be set (16+ characters), not serving the files.");
    process.exit(1);
}

http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.searchParams.get("key") !== KEY) {
        response.writeHead(403).end("Forbidden\n");
        return;
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!name) {
        const files = fs.readdirSync(OUTPUT_DIR).filter((file) => fs.statSync(path.join(OUTPUT_DIR, file)).isFile() && !file.startsWith("."));
        const lines = files.map((file) => `${file}\t${(fs.statSync(path.join(OUTPUT_DIR, file)).size / 1e6).toFixed(1)} MB`);
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(lines.join("\n") + "\n");
        return;
    }
    const file = path.join(OUTPUT_DIR, path.basename(name));
    if (!fs.existsSync(file) || name.startsWith(".")) {
        response.writeHead(404).end("Not found\n");
        return;
    }
    response.writeHead(200, {
        "Content-Type": file.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
    });
    fs.createReadStream(file).pipe(response);
}).listen(PORT, () => console.log(`Serving ${OUTPUT_DIR} on port ${PORT}`));
