## Correção de status em varreduras com frota dinâmica (#1566–#1568)

O jogo pode renderizar a página nativa terminal com uma quantidade diferente
da esperada pelo cabeçalho `Routes(N)`, mesmo após duas leituras de identidade
estáveis: na produção #1568, `Routes(187)` e oito cartões observados na
página 10. O executor **confirmou 25 voos**, com zero cliques de resultado incerto
e um HOLD por demanda insuficiente. A condição terminal fazia o workflow ficar
vermelho como `FIRST_PAGE_DISPATCH_INCOMPLETE_OR_UNVERIFIED`, ocultando
a distinção entre voos comprovadamente executados e *cobertura global incompleta*.

O novo tratamento **não declara a frota ociosa nem completa**. Somente
quando a última página apresentou identidades nativas verificadas em duas
leituras, **zero READY**, e houve ao menos uma decolagem confirmada sem
incerteza durante este run, o encerramento recebe a classificação
`rollingTerminalPartialCoverage`. A incompletude persiste explicitamente
no relatório: `rollingWindowUnverified=true`.

A operação deixa de falhar por um fato alheio às decolagens individuais
já confirmadas, e registra um **warning** `PARTIAL_NATIVE_FLEET_COVERAGE`
no GitHub Actions. O sucesso representa estritamente o **escopo de
decolagens comprovadas**, nunca o exame de toda a frota; os demais aviões
precisam continuar sendo considerados nas próximas execuções.

Permanecem erros (vermelhos): nenhuma decolagem comprovada com janela
não verificada; qualquer resultado incerto após click; tentativas sem
confirmação/identity; HOLDs por indisponibilidade de controle, combustível
não comprovado, CAPTCHA, prazo ou execução interrompida; página terminal
com aeronaves READY; drift não verificado; varredura interrompida no meio.

**Aviso**: o estado final da frota em movimento não pode ser inferido de
um único conjunto de offsets. Não usar o status verde isoladamente como
prova de todas as aeronaves terem partido.
