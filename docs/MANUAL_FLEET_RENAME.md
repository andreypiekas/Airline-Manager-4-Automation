# Renomear frota inteira — workflow exclusivamente manual (M4)

> Workflow: [Renomear frota manualmente](../.github/workflows/manual-fleet-rename.yml). Não possui cron, não é chamado pela produção e **não dispara nenhuma decolagem, compra, ajuste de tarifa, reroute ou campanha**.

## Diagnóstico dos editores (somente leitura)

Antes de autorizar `apply`, especialmente após o erro `RENAME_PROMPT_CONTROL_UNVERIFIED` no run [#39708000395](https://github.com/andreypiekas/Airline-Manager-4-Automation/actions/runs/39708000395), execute **Actions → Renomear frota manualmente → Run workflow → main → operation: inspect**. Deixe os demais campos vazios.

A operação `inspect` abre o Fleet e os detalhes da **primeira aeronave** por seu controle nativo, verifica a rota e a identidade e **apenas lê** os controles de renomeação de aeronave e rota. Não clica nos botões editores, não aceita `prompt` e não faz AJAX de gravação.

No artefato `manual-fleet-rename-report`, confira `inspection.allVerified`, `inspection.editors` e a tabela *Inspeção nativa (somente leitura)*. São mostrados somente contagens, visibilidade, habilitação, validação estrita e o formato sanitizado dos handlers (sem IDs, URLs reais, nomes ou código original).

Na inspeção aprimorada, cada editor também possui `form`: quantidade de campos de entrada presentes na área oculta, quantidade de campos cujo `.val()` é referenciado pelo botão, tipo genérico do campo e possíveis controles visíveis de abertura de formulário. Essas observações são somente leitura e **não incluem os IDs, nomes ou valores dos inputs**. Um controle candidato de abertura não é automaticamente considerado seguro para clicar. A inspeção não altera CSS nem abre o formulário.

**Inspeção da abertura nativa (sem gravação):** existe uma opção manual distinta `operation=inspect-open`. Ela consulta os mesmos campos do modo `inspect` e, somente quando a callback da abertura é **exatamente** a sequência nativa `hide();show();` para a região oculta verificada (com som neutro opcional), clica exclusivamente no controle de abertura. A rotina não preenche campos, não lê seu conteúdo, não clica em Salvar e não envia Ajax de edição. Os campos adicionais `openerStrictlyVerified`, `openerActivated`, `buttonVisibleAfterOpener` e `inputVisibleAfterOpener` registram o que foi comprovado. Outros formatos não são executados; a operação não habilita `apply`.

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

O SHA256 considera os IDs de aeronave e rota, o registro atual, os nomes desejados e o **par exato de aeroportos em ordem canônica**. Assim, a inversão normal de sentido de um voo (por exemplo, `GRU - JAU` e `JAU - GRU`) não invalida a prévia; uma mudança real de aeroportos, IDs, nomes pretendidos ou registro **continua invalidando**. A verificação ao vivo também compara o par de aeroportos independentemente da ordem.

**Correção de 22/10/2026:** como o cálculo de SHA256 foi corrigido, **nenhum hash de prévia anterior é reutilizável** (inclusive `4f054eb6…`). Execute nova `preview` com a `main` atual e os prefixos originais, revise o CSV e use apenas o novo SHA256 no piloto.

### Contagem da frota muda durante uma prévia ou pilot-check

A [execução read-only #39809109069](https://github.com/andreypiekas/Airline-Manager-4-Automation/actions/runs/39809109069) parou em `COLLECT_FLEET` com `RENAME_FLEET_COUNT_CHANGED`, antes de verificar os editores e **sem renomeação**. Isso significa que a contagem exibida variou **durante o inventário**; o log não demonstra se houve alteração real da frota ou atualização temporária da UI.

Nos modos **somente leitura** `preview` e `pilot-check`, o programa agora descarta o inventário incompleto, reabre a lista nativa e refaz a coleta inteira **uma única vez**. Persistindo a mudança ou ocorrendo divergência de identificação (ID de aeronave, rota, registro ou par de aeroportos), a operação interrompe sem gravar. Uma nova frota legítima produz um SHA256 diferente e exige nova prévia; **não existe atualização automática de autorização**.

**No modo `pilot`, nenhuma tentativa extra de coleta ou gravação é realizada**. `apply` global permanece bloqueado. A correção não comprova a causa raiz da variação nem autoriza renomeação.

### Rastreamento dos detalhes da aeronave — sem gravação

A execução [`pilot-check` #39840074401](https://github.com/andreypiekas/Airline-Manager-4-Automation/actions/runs/39840074401) aprovou a coleta das **114 aeronaves** e o SHA256 `9190c236e59343ce3d6f42ff02b1fc63972cd20db0ea00f99204b2475af4a992`. Falhou ao tentar abrir os detalhes do alvo, com `stage=PILOT_PREFLIGHT_OPEN_TARGET_DETAILS`, `failureCode=RENAME_PILOT_PREFLIGHT_UI_EXCEPTION`, **sem gravar nomes**.

O relatório anterior não registrava qual verificação dos detalhes ocorreu. Agora `pilot-check` registra apenas **nomes estáticos de estágios**, como `PILOT_TARGET_REOPEN_FLEET`, `PILOT_TARGET_FLEET_WAIT_OLD_CONTAINER_DETACH`, `PILOT_TARGET_FIND_ROUTE`, `PILOT_TARGET_VERIFY_REGISTRATION`, `PILOT_TARGET_CLICK_DETAILS_LINK` e `PILOT_TARGET_VERIFY_DETAILS_CONTENT`, sem conteúdo da página, URL, nomes, IDs ou comandos nativos. Assim, uma nova inspeção somente leitura poderá identificar a etapa específica sem flexibilizar os controles.

A causa raiz da falha no detalhe **ainda não foi demonstrada**. Não repetir o modo `pilot` até que `pilot-check` valide os dois campos.

## Etapa 2: pré-validação de piloto — sem salvar nada

Quando um piloto falha antes do primeiro checkpoint, execute apenas **`operation=pilot-check`** no workflow manual da `main`: informe **`pilot_aircraft_id`** e os mesmos prefixos (ou CSV) + **`expected_preview_sha256`** da última prévia aprovada. Deixe `confirmation` vazio. A operação consulta as 104 aeronaves, confere o digest e a identidade do alvo e inspeciona os dois editores nativos, **sem preencher campo, abrir botão de edição ou enviar qualquer comando de renomeação**.

O relatório identifica a última fase estática de validação: `PILOT_PREFLIGHT_OPEN_TARGET_DETAILS` e `PILOT_PREFLIGHT_{AIRCRAFT|ROUTE}_{FIND_CONTROL|FIND_PANEL|FIND_INPUT|FIND_OPENER}`. Mensagens brutas da página, CSS, IDs de inputs, callbacks e nomes não são persistidos. `PILOT_PREFLIGHT_VERIFIED_READ_ONLY` confirma apenas os controles, **não equivale a piloto executado**.

Foi observado no run [#39795677436](https://github.com/andreypiekas/Airline-Manager-4-Automation/actions/runs/39795677436) que o hash canônico foi aprovado e a primeira inspeção falhou em `PILOT_PREFLIGHT_TWO_NATIVE_EDITORS` com erro não classificado, **sem resultados/alterações**. A nova etapa `pilot-check` foi feita para esclarecer esse bloqueio com segurança. Não repita o piloto real antes de avaliar esse relatório.

## Etapa 2: piloto de uma aeronave (operações reais e isoladas)

Após a inspeção `inspect-open` comprovada no jogo, uma **operação manual distinta `pilot`** pode testar a gravação dos dois registros **de uma única aeronave**, escolhida expressamente pelo operador. **Não é executada automaticamente nem pelo assistente.**

1. Rode uma prévia `preview` na `main`, com `aircraft_prefix=XP` e `route_prefix=XR` (ou o CSV completo); revise `rename-proposal.csv`, anote o `aircraftId` da aeronave desejada e o SHA256 da **nova** prévia.
2. Rode manualmente o mesmo workflow em `operation=pilot`, fornecendo exatamente os mesmos prefixos/CSV, `pilot_aircraft_id=<ID EXATO>`, `expected_preview_sha256=<HASH NOVO>` e `confirmation=APLICAR_PILOTO_UMA_AERONAVE`.
3. O programa verifica a **frota inteira** e seu hash, confere a rota/registro atuais, valida ambos os campos de texto e controles nativos **antes de mudar qualquer nome**, mas então trabalha **somente** na aeronave indicada.
4. Antes de cada clique de salvamento, registra intenção no `rename-report.json`; abre o formulário via `hide()/show()` nativo verificado, preenche somente o campo exato, executa uma única ação de gravação nativa e confere resposta AJAX + novo nome exibido no jogo.
5. Qualquer falha ou retorno incerto interrompe imediatamente a execução. Se o campo da aeronave tiver sido confirmado, mas o da rota falhar, haverá **alteração parcial**. Não existe rollback automático e **não se deve executar novamente** o piloto sem examinar o resultado e gerar uma nova prévia.

**A opção `apply` de toda a frota fica expressamente bloqueada** no código até o piloto real estar concluído, documentado e a retomada em lotes ter sido desenhada. Os testes offline não substituem um piloto real.

## Operação global — bloqueada até a validação do piloto

Embora a opção `apply` ainda esteja visível por compatibilidade no menu, ela **recusa a execução antes do login** com `RENAME_BULK_REQUIRES_VALIDATED_PILOT`. Não use `apply`: o modo `pilot` é o único caminho de gravação disponível e atua em somente uma aeronave, com dois campos e autorização específica.

Para liberar no futuro a renomeação completa, precisamos validar um piloto real aprovado, confirmar os dois nomes na interface e implementar lotes com checkpoint e retomada segura. O bot não repete automaticamente gravações com resultado incerto. As operações `preview`, `inspect` e `inspect-open` permanecem sem gravação de nomes.

## Segurança e histórico

O workflow compartilha o mesmo grupo de concorrência da automação principal e exige o commit `main` atual. A gravação de intenção antecede cada clique, e `rename-report.json/.md` registra cada campo confirmado, retido ou incerto, disponível no artifact por 14 dias. Senhas não aparecem no CSV, screenshots, trace ou vídeo. Os nomes são dados administrativos de jogo, mas revise seu conteúdo antes de compartilhar relatórios.

O modo **preview** sempre é somente leitura e não usa permissões de escrita no repositório. Nenhum modo é executado automaticamente.
