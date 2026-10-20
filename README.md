# QG Elite Nutrição

Plataforma de estudos para o concurso de Nutricionista de Trindade/PE.

## Abrir a plataforma

Abra `index.html` diretamente ou use o Live Server. A Mentoria funciona em modo local sem chave de API: pesquisa no acervo da plataforma e mostra trechos e respostas relacionados à pergunta. Se não encontrar material suficiente, oferece atalhos para pesquisar na web ou imagens no Google, sem apresentar esses resultados externos como se já tivessem sido consultados.

## Publicar no GitHub Pages

O site é estático e pode ser hospedado no GitHub Pages sem Node.js, servidor ou chave secreta:

1. Envie `index.html` para o repositório GitHub.
2. No repositório, abra **Settings → Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**, escolha `main` e a pasta `/(root)`, então clique em **Save**.
4. Aguarde a publicação e abra o endereço exibido na seção Pages.

O backend opcional `server.js` integra o Google Gemini e requer uma chave privada. O GitHub Pages não executa esse backend. Não publique `.env`, chaves de API nem credenciais; o `.gitignore` já exclui `.env`.
