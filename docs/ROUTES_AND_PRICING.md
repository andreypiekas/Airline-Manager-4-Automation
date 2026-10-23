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
