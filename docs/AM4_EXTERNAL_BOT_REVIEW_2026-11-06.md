# Referências externas de AM4 — revisão técnica de 06/11/2026

Esta revisão compara dois repositórios MIT com a arquitetura de decolagem
individual e primeira página nativa de `andreypiekas/Airline-Manager-4-Automation`.

## Referências

- [JavierOlmedo/AirlineManager4Bot](https://github.com/JavierOlmedo/AirlineManager4Bot)
  — Python/Selenium, atividade de código em outubro de 2026, [licença MIT](https://github.com/JavierOlmedo/AirlineManager4Bot/blob/main/LICENSE).
  - [src/bot.py](https://github.com/JavierOlmedo/AirlineManager4Bot/blob/main/src/bot.py):
    `_LOADED_JS` exige fragmento com conteúdo e **sem imagem loader**,
    e `ajax` aguarda esse sinal antes de ler;
  - [src/maintenance.py](https://github.com/JavierOlmedo/AirlineManager4Bot/blob/main/src/maintenance.py):
    lê `data-hours`, `data-wear`, `data-reg` e identificador nativo do
    cartão de manutenção;
  - [src/fleet.py](https://github.com/JavierOlmedo/AirlineManager4Bot/blob/main/src/fleet.py):
    observa estados e modelos, calcula demanda, receita e rentabilidade;
  - `_depart_all` usa botão global e não demonstra reconciliação individual
    do resultado de cada aeronave; não serve para substituir o nosso
    `IndividualDepartureExecutor`.

- [LouisJeanneau/Airline-Manager-4-Bot](https://github.com/LouisJeanneau/Airline-Manager-4-Bot)
  — JavaScript/Tampermonkey e Python/Selenium, última atualização de código
  em junho de 2024, [licença MIT](https://github.com/LouisJeanneau/Airline-Manager-4-Bot/blob/master/LICENSE).
  - [am4.js](https://github.com/LouisJeanneau/Airline-Manager-4-Bot/blob/master/am4.js):
    controles globais `listDepartAmount`, compras por XHR e intervalos;
  - [python/am4.py](https://github.com/LouisJeanneau/Airline-Manager-4-Bot/blob/master/python/am4.py):
    clique `Depart all`, seleção por XPath posicional e waits fixos.
  - Não mesclar: cliques sem confirmação específica, dependência de
    posicionamento do DOM, compra sem confirmação pós-ação e ausência
    de journal/quarentena.

## O que foi incorporado, com implementação independente

**Somente a ideia de aguardar um fragmento AJAX nativo carregado**.
`demand/navigation.ts` já exigia transição do contêiner ou resposta
`routes.php` nativa, cartões presentes e validação de controle/cursor.
Agora também espera ausência de **loader visível no `#routesContainer`**.
A leitura passiva também recusa reutilizar uma primeira página já aberta
ou amostrá-la enquanto esse loader estiver visível.

- O bot **não** remove conteúdo do DOM, chama AJAX diretamente,
  tenta clicar de novo ou atravessa páginas.
- Loader remanescente causa falha na leitura, não mutação.
- Dupla leitura de identidade e controle individual permanecem necessários.
- Esse ajuste reduz uma classe de leitura prematura, mas **não resolve
  sozinho** as janelas legítimas de menos de 20 cartões, páginas
  alteradas após partidas, ou disponibilidade de outras páginas.
- Os atributos de manutenção apresentados por Javier **já são lidos**
  em `optimization/maintenance-reader.ts` durante investigação
  read-only; o painel *Bulk check* em `utils/maintenance.utils.ts`
  ainda depende de prova verificável própria por cartão.
  Não transferir `data-hours` de uma tela para outra sem identidade
  e equivalência nativas confirmadas.

Esta mudança não usa código literal de terceiros: deriva um princípio
técnico observável e o implementa de forma específica para Playwright,
com testes locais e atribuição da referência original.
