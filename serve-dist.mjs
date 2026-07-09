import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve('dist')
const port = 4173
const host = '127.0.0.1'

const mimeTypes = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', `http://${host}:${port}`).pathname
    const relativePath =
      requestPath === '/' ? 'index.html' : normalize(requestPath).replace(/^([/\\])+/, '')
    let filePath = join(root, relativePath)

    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('Forbidden')
      return
    }

    if (!existsSync(filePath)) {
      filePath = join(root, 'index.html')
    } else {
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        filePath = join(filePath, 'index.html')
      }
    }

    const extension = extname(filePath)
    response.writeHead(200, {
      'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })

    createReadStream(filePath).pipe(response)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  }
}).listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}`)
})
