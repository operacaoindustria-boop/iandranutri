import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const model = 'gemini-3.8-flash';
const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const maxRequestBytes = 24 * 1024;
const rateLimitWindowMs = 60_000;
const maxRequestsPerWindow = 20;
const requestsByAddress = new Map();

function loadLocalEnvironment() {
    let envFile;
    try {
        envFile = readFileSync(join(projectDir, '.env'), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }

    envFile.split(/\r?\n/).forEach(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || Object.hasOwn(process.env, match[1])) return;
        const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
        process.env[match[1]] = value;
    });
}

loadLocalEnvironment();

function sendJson(response, status, data) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(data));
}

function checkRateLimit(address) {
    const now = Date.now();
    const recent = (requestsByAddress.get(address) || []).filter(timestamp => now - timestamp < rateLimitWindowMs);
    if (recent.length >= maxRequestsPerWindow) {
        requestsByAddress.set(address, recent);
        return false;
    }
    recent.push(now);
    requestsByAddress.set(address, recent);
    return true;
}

async function readJsonBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxRequestBytes) {
            const error = new Error('A solicitação excedeu o tamanho permitido.');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('O formato da solicitação é inválido.');
        error.status = 400;
        throw error;
    }
}

function validateMessages(body) {
    if (!body || typeof body.question !== 'string') {
        return { error: 'Envie uma pergunta para a mentoria.' };
    }

    const question = body.question.trim();
    if (!question || question.length > 2000) {
        return { error: 'A pergunta deve ter entre 1 e 2.000 caracteres.' };
    }

    if (body.messages !== undefined && !Array.isArray(body.messages)) {
        return { error: 'O histórico enviado é inválido.' };
    }

    const messages = (body.messages || []).slice(-10);
    let historyLength = 0;
    for (const message of messages) {
        if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
            return { error: 'O histórico enviado contém uma mensagem inválida.' };
        }
        if (message.content.length > 3000) {
            return { error: 'Uma mensagem do histórico excede o limite permitido.' };
        }
        historyLength += message.content.length;
    }
    if (historyLength > 12_000) {
        return { error: 'O histórico está muito longo. Inicie uma nova conversa.' };
    }

    return { question, messages };
}

function buildPrompt(question, messages) {
    const history = messages.map(message =>
        `${message.role === 'user' ? 'Candidata' : 'Mentoria'}: ${message.content}`
    ).join('\n\n');

    return `Você é a Mentoria IA de uma plataforma de estudos para o concurso de Nutricionista de Trindade, Pernambuco.

Responda em português do Brasil. A pessoa pode perguntar sobre qualquer assunto, não apenas o edital. Seja clara, didática, acolhedora e direta. Para ensinar, organize a resposta, quando couber, em: resposta direta; explicação passo a passo; exemplo concreto ou cálculo resolvido; e dica de prova. Use títulos e listas simples quando ajudarem. Se a pergunta pedir algo atual, controverso ou que dependa de legislação, pesquise na web usando a ferramenta disponível e diferencie fato confirmado de incerteza. Prefira fontes oficiais e primárias. Nunca invente citações ou alegue que pesquisou se não houver resultados. Para saúde, ofereça informação geral e recomende avaliação profissional quando a pergunta pedir diagnóstico ou tratamento individual. Não afirme que substitui um profissional.

Histórico recente:
${history || '(início da conversa)'}

Pergunta atual:
${question}`;
}

function extractInteraction(responseData) {
    const steps = Array.isArray(responseData.steps) ? responseData.steps : [];
    const outputSteps = steps.filter(step => step.type === 'model_output');
    const textParts = outputSteps.flatMap(step =>
        Array.isArray(step.content) ? step.content.filter(part => part.type === 'text') : []
    );
    const answer = responseData.output_text ||
        textParts.map(part => part.text || '').join('\n').trim() ||
        (Array.isArray(responseData.output)
            ? responseData.output.filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim()
            : '');

    const sources = textParts.flatMap(part => Array.isArray(part.annotations) ? part.annotations : [])
        .filter(annotation => annotation.type === 'url_citation' && typeof annotation.url === 'string')
        .map(annotation => ({ title: annotation.title || annotation.url, url: annotation.url }))
        .filter(source => {
            try {
                return new URL(source.url).protocol === 'https:';
            } catch {
                return false;
            }
        })
        .filter((source, index, all) => all.findIndex(item => item.url === source.url) === index)
        .slice(0, 8);
    const searchQueries = steps
        .filter(step => step.type === 'google_search_call' && Array.isArray(step.arguments?.queries))
        .flatMap(step => step.arguments.queries)
        .filter(query => typeof query === 'string')
        .slice(0, 5);

    return { answer, sources, searchQueries };
}

async function handleMentor(request, response) {
    const origin = request.headers.origin;
    const expectedOrigin = `http://${request.headers.host}`;
    if (origin && origin !== expectedOrigin) {
        sendJson(response, 403, { error: 'Origem da solicitação não permitida.' });
        return;
    }
    if (!request.headers['content-type']?.includes('application/json')) {
        sendJson(response, 415, { error: 'A solicitação deve ser enviada em formato JSON.' });
        return;
    }
    if (!checkRateLimit(request.socket.remoteAddress || 'unknown')) {
        sendJson(response, 429, { error: 'Muitas perguntas em pouco tempo. Aguarde um minuto e tente novamente.' });
        return;
    }

    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, error.status || 400, { error: error.message });
        return;
    }

    const validated = validateMessages(body);
    if (validated.error) {
        sendJson(response, 400, { error: validated.error });
        return;
    }
    if (!process.env.GEMINI_API_KEY) {
        sendJson(response, 503, { error: 'A chave Gemini ainda não foi configurada. Adicione GEMINI_API_KEY ao arquivo .env e reinicie o servidor.' });
        return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
        const upstreamResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
                model,
                input: buildPrompt(validated.question, validated.messages),
                tools: [{ type: 'google_search' }]
            }),
            signal: controller.signal
        });
        const responseData = await upstreamResponse.json().catch(() => ({}));
        if (!upstreamResponse.ok) {
            console.error(`Gemini API returned HTTP ${upstreamResponse.status}.`);
            const status = upstreamResponse.status === 429 ? 429 : 502;
            sendJson(response, status, {
                error: upstreamResponse.status === 429
                    ? 'O limite de uso do Gemini foi atingido. Aguarde e tente novamente.'
                    : 'O Gemini não conseguiu responder agora. Confira a chave e o acesso à API, depois tente novamente.'
            });
            return;
        }

        const result = extractInteraction(responseData);
        if (!result.answer) {
            console.error('Gemini API returned no text output.');
            sendJson(response, 502, { error: 'A IA retornou uma resposta vazia. Tente reformular a pergunta.' });
            return;
        }
        sendJson(response, 200, { ...result, model });
    } catch (error) {
        if (error.name === 'AbortError') {
            sendJson(response, 504, { error: 'A resposta demorou demais. Tente novamente.' });
            return;
        }
        console.error(`Gemini API request failed: ${error.message}`);
        sendJson(response, 502, { error: 'Não foi possível conectar ao Gemini. Verifique sua conexão com a internet e tente novamente.' });
    } finally {
        clearTimeout(timeout);
    }
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { configured: Boolean(process.env.GEMINI_API_KEY) });
        return;
    }
    if (url.pathname === '/api/mentor' && request.method === 'POST') {
        void handleMentor(request, response);
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Rota da API não encontrada.' });
        return;
    }
    if (request.method !== 'GET' || !['/', '/index.html'].includes(url.pathname)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Não encontrado.');
        return;
    }

    readFile(join(projectDir, 'index.html'), (error, content) => {
        if (error) {
            response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Não foi possível carregar a plataforma.');
            console.error(`Unable to read index.html: ${error.message}`);
            return;
        }
        response.writeHead(200, {
            'Content-Type': mimeTypes[extname('index.html')],
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        });
        response.end(content);
    });
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Plataforma disponível em http://127.0.0.1:${port}`);
    if (!process.env.GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY não configurada; a mentoria exibirá as instruções de configuração.');
    }
});
