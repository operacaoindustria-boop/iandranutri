# QG Elite Nutrição

## Iniciar a plataforma e a Mentoria IA

A Mentoria IA precisa do backend local para manter a chave Gemini fora do navegador. Não abra a plataforma pelo Live Server para usar a IA.

1. Instale o Node.js 18 ou superior.
2. Na pasta do projeto, crie o arquivo local de configuração:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Abra `.env` e preencha `GEMINI_API_KEY` com uma chave criada no Google AI Studio. Não envie essa chave em conversas, não a coloque no `index.html` e não compartilhe o arquivo `.env`.
4. Inicie o servidor:

   ```powershell
   npm start
   ```

5. Abra `http://127.0.0.1:3000` no navegador. Mantenha o terminal aberto enquanto usar a plataforma.

O status no cabeçalho da Mentoria informa se o servidor e a chave estão configurados. A IA usa a API Gemini e pode consultar a Pesquisa Google para perguntas que dependam de informações atuais. As respostas podem incluir links de fontes e uma busca de imagens relacionadas.
