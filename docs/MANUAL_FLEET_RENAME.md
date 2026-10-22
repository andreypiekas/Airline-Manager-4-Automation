# Renomear frota inteira — workflow exclusivamente manual (M4)

> Workflow: [Renomear frota manualmente](../.github/workflows/manual-fleet-rename.yml). Não possui cron, não é chamado pela produção e **não dispara nenhuma decolagem, compra, ajuste de tarifa, reroute ou campanha**.

## Diagnóstico dos editores (somente leitura)

Antes de autorizar `apply`, especialmente após o erro `RENAME_PROMPT_CONTROL_UNVERIFIED` no run [#39708000395](https://github.com/andreypiekas/Airline-Manager-4-Automation/actions/runs/39708000395), execute **Actions → Renomear frota manualmente → Run workflow → main → operation: inspect**. Deixe os demais campos vazios.

A operação `inspect` abre o Fleet e os detalhes da **primeira aeronave** por seu controle nativo, verifica a rota e a identidade e **apenas lê** os controles de renomeação de aeronave e rota. Não clica nos botões editores, não aceita `prompt` e não faz AJAX de gravação.

No artefato `manual-fleet-rename-report`, confira `inspection.allVerified`, `inspection.editors` e a tabela *Inspeção nativa (somente leitura)*. São mostrados somente contagens, visibilidade, habilitação, validação estrita e o formato sanitizado dos handlers (sem IDs, URLs reais, nomes ou código original).

Na inspeção aprimorada, cada editor também possui `form`: quantidade de campos de entrada presentes na área oculta, quantidade de campos cujo `.val()` é referenciado pelo botão, tipo genérico do campo e possíveis controles visíveis de abertura de formulário. Essas observações são somente leitura e **não incluem os IDs, nomes ou valores dos inputs**. Um controle candidato de abertura não é automaticamente considerado seguro para clicar. A inspeção não altera CSS nem abre o formulário.

`allVerified=true` confirma **somente a forma estática dos dois comandos de uma aeronave**, não comprova sucesso de gravação, outros modelos de aeronave, duração, idempotência ou rollback. **Não executar `apply` em toda a frota baseado apenas nisso**; fazer primeiro um piloto manual aprovado e com relatório de confirmação de ambos os campos.

## Etapa 1: prévia (nenhuma alteração)

No GitHub, acesse **Actions → Renomear frota manualmente → Run workflow**, selecionando **main** e operação **preview**.

Opção A — deixar os campos de nome vazios. A execução coleta a frota, verifica a contagem e os IDs, e disponibiliza `rename-template.csv` para edição manual. Cada linha representa **uma aeronave e sua rota**, com colunas:

```csv
aircraftId,routeId,aircraftRegistration,routeRegistration
123,456,XP-001,XR-001
124,457,XP-002,XR-002
```

O exemplo é fictício. Todos os registros reais precisam vir do arquivo gerado pela sua própria prévia. Cole o CSV preenchido em **mapping_csv** e execute novamente em modo **preview**.

Opção B — preencher **aircraft_prefix** e **route_prefix** (por exemplo `XP` e `XR`) e deixar `mapping_csv` vazio. O bot gera para **toda a frota** o padrão de numeração `XP-001`, `XP-002` … e `XR-001`, `XR-002` …, ordenado por ID estável de aeronave.

Em ambos os casos, o artefato `manual-fleet-rename-report` contém a proposta `rename-proposal.csv`, o inventário ou o template, o JSON, um resumo e o **SHA256 da prévia**.

## Etapa 2: aplicar (operação real, somente com consentimento)

Revise integralmente o CSV. Depois execute o **mesmo workflow manual** em modo **apply**, com os mesmos prefixos ou o CSV final **exatamente igual ao da prévia**, e informe:

- **expected_preview_sha256**: digest do relatório anterior.
- **confirmation**: `APLICAR_RENOMEACAO_TOTAL`.

A aplicação recusa resultado parcial ou ambíguo de Fleet, nomes inválidos ou repetidos, IDs divergentes, hash diferente, reexecução do mesmo GitHub run, controle de UI desconhecido ou challenge/CAPTCHA.

Para cada aeronave, a ordem é: validar `aircraftId` e `routeId`; abrir os detalhes nativos; usar o editor nativo do **registro da aeronave** (`mode=reg`); confirmar resposta AJAX e registro exibido; reabrir os detalhes; usar o editor nativo do **registro da rota** (`mode=routeReg`); confirmar a resposta e valor exibido no cabeçalho da rota. Os dois campos são tratados como operações distintas.

**Limitação importante:** o jogo pode mudar seus editores. A rotina de aplicação suporta apenas botões cujo callback já exibe uma operação nativa AJAX com `prompt()` para o ID e campo exatos. Se o controle real for diferente, a execução fará **HOLD**, sem tentar enviar uma requisição inventada. Se o servidor responder sem confirmação visual do novo valor, será marcado como **resultado incerto**, sem retry. O workflow pode parar após modificar apenas parte da frota; **não deve ser repetido automaticamente**. Examine o artefato antes de iniciar nova operação.

O inventário é **leve e somente leitura**: percorre as páginas nativas de Fleet/Routes e confere 1:1 com `Routes(N)`, sem abrir todos os detalhes ou reler demanda de cada aeronave. Uma página incompleta, repetida ou com callback desconhecido bloqueia a operação. O escopo são todas as aeronaves **visíveis em Fleet/Routes**, não aeronaves eventualmente sem rota que não apareçam nessa tela.

O hash inclui os IDs, o registro atual de cada aeronave e a descrição original de sua rota; mudanças relevantes entre prévia e aplicação exigem nova prévia. Não use nomes para identificar aeronaves nos demais módulos: os identificadores técnicos permanecem `aircraftId` e `routeId`.

## Segurança e histórico

O workflow compartilha o mesmo grupo de concorrência da automação principal e exige o commit `main` atual. A gravação de intenção antecede cada clique, e `rename-report.json/.md` registra cada campo confirmado, retido ou incerto, disponível no artifact por 14 dias. Senhas não aparecem no CSV, screenshots, trace ou vídeo. Os nomes são dados administrativos de jogo, mas revise seu conteúdo antes de compartilhar relatórios.

O modo **preview** sempre é somente leitura e não usa permissões de escrita no repositório. Nenhum modo é executado automaticamente.
