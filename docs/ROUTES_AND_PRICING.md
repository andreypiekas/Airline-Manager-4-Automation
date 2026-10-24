# Rotas e Pricing PAX

Este documento descreve três módulos relacionados, mas independentes: **pricing**, **route review** e **reroute**.

## Pricing PAX

A referência é sempre o **Auto Price nativo observado na rota**.

```text
Y = Auto × 1.10
J = Auto × 1.08
F = Auto × 1.06
```

O resultado é arredondado para baixo ao múltiplo de 10.

Classes sem assentos não recebem valor para Save.

### Fluxo

1. validar aeronave, rota e idade da observação;
2. ler o controle Auto sem executar seu JavaScript;
3. calcular o alvo;
4. comparar com o preço atual;
5. salvar somente quando autorizado;
6. reler a rota;
7. confirmar que os valores persistiram.

Preço já correto resulta em `unchanged`/equivalente e não provoca Save. Resultado incerto entra em quarentena e não é repetido automaticamente.

## Route review

A revisão **programada** (retorno/diária) exige uma origem operacional confiável para a aeronave.

A origem pode vir de:

- override explícito por `aircraftId`; ou
- uma única base da companhia presente na rota atual.

O trigger `demand_insufficient` é diferente: ele pode usar o **aeroporto atual observado** como origem de pesquisa, desde que a aeronave esteja pronta e todo o contexto esteja fresco e verificável. Isso permite reavaliar uma aeronave sem demanda mesmo fora de um hub, sem relaxar os gates econômicos ou de mutação.

### Gatilhos

A revisão pode ocorrer:

- após retorno confirmado à própria base;
- uma vez ao dia quando a aeronave é observada em solo na própria base; ou
- imediatamente quando o Demand Manager produz `hold_insufficient`.

O gatilho de demanda tem prioridade sobre a fila normal e pode pesquisar a partir do aeroporto atual. Isso não transforma a falta de demanda em autorização de reroute.

Quando o Demand Manager confirma `hold_insufficient`, a rota atual não é tratada como se fosse economicamente ruim por estimativa. O comparador usa uma base explícita de **oportunidade operacional**: a rota atual não possui departure autorizado naquele momento. Uma candidata só pode vencer essa situação quando o próprio ciclo ida+volta estiver completamente verificado, a concorrência de demanda estiver conservadoramente reservada e o primeiro ciclo permanecer positivo mesmo depois da taxa de criação/troca. O relatório identifica essa base como `verified_demand_hold_opportunity`.

Estar apenas em solo não prova um retorno.

## Pesquisa direta do catálogo comunitário — além das sugestões nativas

O arquivo `reference-report.json` inclui `catalogDiscovery` e o novo
`catalog-discovery.md` mostra cobertura por base e candidatos por aeronave,
independentemente dos botões de sugestão do AM4. O algoritmo lê **todos os
registros conhecidos** do catálogo curado `data/reference/routes.json`
(sem realizar requisições adicionais ao jogo) e seleciona no máximo 20 opções
para cada aeronave elegível.

Filtros conservadores de pré-pesquisa:
- identidade, base operacional, estado e capacidade atual da aeronave sem ambiguidades;
- alcance direto da aeronave;
- pista de ambos os aeroportos, conforme cadastro comunitário inequívoco;
- demanda diária estática e distância válidas, sem pares duplicados conflitantes;
- cálculo de tarifa teórica nos dois modos Easy e Realism, sem adivinhar o modo real.

A ordem é dada pelo **menor teto bruto hipotético por partida entre os dois modos**,
com desempate por cobertura de assentos estática. Isso **não é lucro líquido**,
nem demanda restante e nem previsão de ocupação real. Não descarta a possibilidade
de rotas repetidas: apenas informa se o par é o da rota atual.

### Cobertura rotativa da frota

A fila da revisão programada é repartida em **lotes**, em vez de avançar
apenas uma posição a cada janela. Em cada janela de 30 minutos, o deslocamento
é o número de vagas de pesquisa disponíveis depois de priorizar as aeronaves
bloqueadas por demanda insuficiente.

Com 126 aeronaves todas elegíveis e três vagas de pesquisa, esse desenho
alcança 126 identidades em 42 janelas **na condição ideal de frota estável**,
sem reexaminar três vezes quase o mesmo grupo. Frota, disponibilidade,
retorno à base e bloqueios mudam entre janelas; a cobertura real pode ser
mais lenta e não é uma garantia de execução.

A pesquisa rotativa é observação. Ela nunca sinaliza que as cotações ou
os cálculos já estão completos e não altera o limite de trocas reais por run.

### Consulta real de destinos curados (leitura, antes da decisão)

Além das sugestões nativas, `optimization/catalog-live-reader.ts` agora seleciona
no máximo **duas** rotas extras por aeronave pesquisada (`ROUTE_RESEARCH_CATALOG_QUERIES`,
valores 0 a 5). Só consulta destinos com **um** airportId de referência,
identidade de aeronave atual confirmada, pista/alcance aceitos na pré-triagem
e não encontrados entre as sugestões já examinadas.

Usa o próprio endpoint nativo **somente leitura** `new_route_info.php`
sem `mode=do`, verifica resposta HTTP, aeronave, registration, airportId,
origem e destino em duas fontes do painel, fecha pelo controle Back
verificado e encerra diante de qualquer divergência. **Nunca** usa
`Create route` nessa fase.

As cotações confirmadas entram na mesma análise já existente de demanda
restante, ida e volta, passageiros reservados por outras aeronaves, Auto Price,
Fuel, CO2, A-check, reparos, taxa de troca e vantagem conservadora por hora.
Somente a decisão `would_reroute` que passe TODOS os gates de comparação
e controle nativo pode seguir para o `RouteMutationExecutor`, que
reabre a tela, reconfirma o contexto, executa **no máximo uma tentativa
por aeronave** e verifica a nova rota. Resultado incerto entra em quarentena
persistente para impedir repetição cega.

A presença de uma cotação live por si só **não** comprova demanda
restante ou lucro. Rotas sem observação confiável do saldo de demanda
continuam `hold`, não são trocadas. O limite por execução não significa
que todas as possibilidades foram examinadas. O bot não usa telas de
teste como prova de uma troca realizada em produção.

### Evidência observada na frota para priorizar pesquisas

Quando há diversas opções no catálogo, o leitor de cotações dá prioridade a
pares cuja demanda restante já foi observada **recentemente em outras aeronaves
da frota**, preferindo os pares com observações dos dois sentidos. Isso
reordena apenas as **consultas somente leitura**; jamais reaproveita esses
números como autorização de troca. A análise econômica continua exigindo
reservas completas de outras aeronaves, limites conservadores, custos e
comparação validada.

O relatório de pesquisa agora registra o campo sanitizado `failureStage`
quando uma consulta adicional termina sem confirmação. As etapas possíveis
são `challenge`, `planner`, `response`, `quote_identity`,
`screening` e `close`. Nenhuma URL, sessão ou conteúdo do painel é
gravado nesse campo.

### Cobertura incompleta

A versão atual do arquivo foi extraída de `All_routes.xlsx`, filtrado na
importação principalmente pelos hubs GRU, XAP e DTW. TXL possui cobertura escassa.
Esse conjunto **não representa todas as possíveis rotas do jogo** e não cobre
automaticamente escalas. Bases e destinos sem registros aparecem explicitamente
como *não cobertos*, nunca como *sem oportunidades*.

O filtro de pistas é propositalmente conservador, mesmo quando o modo Easy
permitiria mais opções. As rotas resultantes ainda precisam ser consultadas
individualmente no jogo, com confirmação de demanda restante, ida/volta, duração,
pista/alcance, tarifa Auto, competição de outras aeronaves e custos reais.
Este relatório não entra diretamente no executor: `comparisonReady=false`
e `mutationAuthorized=false` sempre.

## Candidatos

Um candidato econômico precisa conter evidências suficientes sobre:

- ida e volta;
- distância e duração;
- alcance e pista;
- demanda restante por classe;
- reservas de outras aeronaves;
- Auto Price por trecho;
- ocupação esperada;
- custos do ciclo;
- custo de criação/troca;
- idade da observação.

Dados ausentes permanecem ausentes. Não são preenchidos com zero.

## Decisões

| Decisão | Significado |
| --- | --- |
| `keep_route` | rota atual permanece melhor ou equivalente dentro da comparação |
| `hold` | não existe evidência suficiente para troca |
| `would_reroute` | candidata superior encontrada, ainda sujeita ao executor |
| `already_reviewed` | evento diário/retorno já consumido |
| `unavailable` | contexto insuficiente |

## Troca individual comprovada com pesquisa parcial

A pesquisa pode retornar várias cotações, mas algumas não têm histórico suficiente
para comprovar ida e volta, demanda restante, concorrência ou custos. Se **ao menos
uma** candidata passou por **todos** os critérios de comparação conservadora
`candidate_dominates` contra a rota atual, tem lucro positivo mesmo após
a taxa de troca e possui controle de mutação confirmado, é possível propor
`would_reroute` para **essa candidata verificada**, sem aguardar que todas
as alternativas inconclusivas sejam resolvidas.

Esse resultado recebe `candidateSetComplete=false` e **não** anuncia melhor
rota global, nem uma pesquisa concluída. `routeDecisionSetComparisonReady`
continua falso enquanto houver qualquer candidata inconclusiva.

Um conjunto parcial **sem** candidata independentemente comprovada
permanece em `hold`: ele nunca vira `keep_route` por falta de evidência.
Uma candidata sem controles nativos confiáveis também continua em `hold`.
A autorização para executar mantém todos os gates existentes, o fingerprint
revalidado, o limite por execução, confirmação pós-alteração e quarentena
em caso de resultado incerto.

## Cenário teórico de ciclos em 24 horas

O relatório `candidate-data.json` passa a registrar `dailyPotential` por candidata e
`dailyPotentialRanking` por aeronave. O motor só calcula essa sensibilidade quando
um ciclo direto de **ida e volta** tiver intervalo econômico validado, reservas de demanda
compartilhada completas e observação recente.

Para cada classe ativa, são computados os passageiros necessários para **ambos** os trechos
usando a faixa superior de ocupação verificada. O teto de ciclos é o menor entre:

- `floor(24 / duração_do_ciclo_em_horas)` — sem considerar paradas ou manutenção;
- `min(floor(demanda_compartilhada_restante_classe / assentos_necessários_por_ciclo_classe))`.

O resultado é **um teto teórico**, não um cronograma executável e nem a previsão real de
lucro diário. Multiplicar a estimativa de lucro variável por esse teto considera
preços e custos constantes e desconta a taxa de criação uma única vez.
Ele não antecipa renovação da demanda, turnarounds, futuras partidas de outras aeronaves
nem eventual mudança de preços. A realidade pode permitir **menos** ciclos ou nenhuma
partida. Os intervalos são sensitividades condicionais, não garantias.

Essa classificação somente leitura não altera o algoritmo de KEEP/HOLD/REROUTE e não
pode autorizar criação, troca de rota, decolagem ou preços. Candidatas com dados
incompletos não recebem projeção numérica.

## Reroute

O executor real é fail-closed.

Uma troca exige, além da recomendação:

- comparação suficientemente completa;
- `comparisonReady=true`;
- `mutationAuthorized=true`;
- alvo nativo ainda fresco;
- identidade da aeronave/rota confirmada;
- limite por run disponível;
- primeira tentativa do GitHub Actions run;
- orçamento de tempo suficiente.

Sugestões limitadas do jogo não são tratadas como prova do melhor destino global. O sistema escolhe a melhor alternativa **entre os candidatos que conseguiu inspecionar e comparar completamente**, ordenando pela margem conservadora verificada.

Após um reroute confirmado, o pricing da rota anterior é descartado. A nova rota precisa fornecer um novo Auto Price e terminar o pricing em estado `adjusted` ou `unchanged` antes de a aeronave poder decolar na mesma run. Caso contrário, ela permanece em `REROUTE_PRICING_NOT_VERIFIED`.

## Configuração

```text
ENABLE_TICKET_PRICING=true
ENABLE_TICKET_PRICING_EXECUTION=true
TICKET_PRICING_MAX_ADJUSTMENTS_PER_RUN=5

ENABLE_ROUTE_RESEARCH=true
ROUTE_RESEARCH_MAX_AIRCRAFT=3
ROUTE_RESEARCH_MAX_SUGGESTIONS=5

ENABLE_ROUTE_OPTIMIZER=true
ROUTE_MIN_OCCUPANCY_PERCENT=80
ROUTE_MIN_IMPROVEMENT_PERCENT=0

ENABLE_ROUTE_EXECUTION=true
ROUTE_MAX_REROUTES_PER_RUN=1
```

Route review e reroute continuam dependentes de evidência econômica verificada; o executor não força uma troca apenas para testar o caminho de mutação.


## Revisao por aeronave: rota atual → calculo → decisao

A coleta validada do jogo ja identifica a rota operacional de cada aeronave. Agora o artifact `aircraft-route-review.json` e a tabela `aircraft-route-review.md` registram, para cada uma:

1. rota atual e desempenho dos voos recentes DO MESMO par (ambos os sentidos), separando receita, consumo efetivo de Fuel e quotas de CO2;
2. valor de reposicao dos insumos com preco atual do mercado, quando observado com identificacao e validade temporal;
3. numero de cotacoes obtidas pelo mecanismo nativo do jogo e pelas referencias estaticas curadas;
4. numero de comparacoes economicamente prontas, decisao conservadora `keep_route`, `would_reroute`, `hold` ou ainda sem pesquisa;
5. rota proposta somente quando houver comparacao individual comprovada e autorizacoes economicas validas.

**Receita menos Fuel e CO2 NAO e lucro liquido.** Nao inclui A-check, reparos, taxas e despesas nao observadas. Nao marca a rota como globalmente melhor nem autoriza alteracao. O executor existente so recebe o plano comprovado, revalida o jogo e aplica o limite de alteracoes por execucao.

A ferramenta externa de rotas no Discord nao foi integrada: nao ha autenticacao/API validada para consulta automatica. Os calculos deste relatorio usam as cotacoes nativas e o catalogo local, deixando claro que a cobertura de alternativas nao e exaustiva. Para integrar uma calculadora externa no futuro, exigir schema validado, fonte confiavel e comprovacao live antes de mutacoes.
