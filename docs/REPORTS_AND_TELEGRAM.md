# Relatórios e Telegram

O projeto separa visão executiva de evidência técnica.

## GitHub Step Summary

O Summary apresenta uma visão curta da run, incluindo quando disponível:

- resultado e modo;
- hubs efetivos e origem da lista;
- frota;
- demanda;
- departures;
- pricing;
- route review/reroute;
- supplies;
- manutenção e campanhas;
- UI Health;
- orçamento de tempo;
- quarentenas;
- estados operacionais que exigem atenção.

A frota inteira não precisa ser repetida quando não há ação necessária.

### Estados operacionais

Os estados do dashboard são diagnósticos operacionais, não sinônimos entre si:

| Estado | Significado |
| --- | --- |
| `NORMAL` | aeronave observada sem ação pendente |
| `PRONTA_PARA_DECOLAR` | pronta, mas a saída foi retida por algum gate da run |
| `AGUARDANDO_DEMANDA` | demanda insuficiente verificada |
| `AGUARDANDO_RECURSO` | combustível/recurso necessário não pôde ser comprovado |
| `DADOS_INDISPONIVEIS` | detalhes da aeronave não puderam ser verificados; não implica problema de rota |
| `QUARENTENA_DECOLAGEM` | departure anterior teve resultado incerto ou quarentena persistente; sem retry automático |
| `ORIGEM_OPERACIONAL_INDEFINIDA` | a origem exigida para revisão/reroute não pôde ser resolvida; não impede por si só a decolagem pela rota existente |
| `PRECISA_REVISAR_ROTA` | existe evidência específica de problema/HOLD na revisão ou execução de reroute |
| `PRECISA_REVISAR_PRECO` | pricing exige revisão ou está em quarentena |
| `MANUTENCAO` | evidência de manutenção/reparo exige atenção |

Assim, `PRECISA_REVISAR_ROTA` não deve ser usado como categoria genérica para qualquer ausência de dados, origem desconhecida ou quarantine de departure.

## Artifact demand-report

Retenção padrão do workflow: 7 dias.

Pode conter:

```text
company-dashboard.json/.md
operational-states.json
owned-airline-bases.json/.md
demand-report.json/.md
execution-report.json/.md
pricing-execution.json/.md
route-execution.json/.md
route-research.json/.md
candidate-data.json/.md
supply-report.json/.md
ui-health.json/.md
run-time-budget.json/.md
```

Além desses arquivos, diagnósticos de Flight History, continuidade e auditorias podem ser incluídos.

## Artifact playwright-report

Contém logs e evidências técnicas permitidas pela configuração do Playwright.

Credenciais, cookies e tokens não devem ser armazenados como evidência.

## Telegram

Quando os Secrets estão configurados, o notifier usa a mesma consolidação do dashboard para evitar divergência entre GitHub e mensagem.

Exemplo de resumo de uma execução com cobertura parcial (valores ilustrativos):

```text
✈️ AIRLINE MANAGER 4  •  #1329
✅ SUCESSO  |  COBERTURA PARCIAL
⚠️ Apenas janelas verificadas. Frota global não auditada.

📍 VISÃO OPERACIONAL
Aeronaves avaliadas nas janelas: 17
Demanda: 15/17 suficientes | insuf. 2 | indispon. 0

🛫 DECOLAGENS
Decolagens: 15/17 confirmadas | retidas 2 | incertas 0
Receita bruta estimada das decolagens: $15,000 (15 confirmadas; nao e lucro nem receita contabil)

⛽ SUPRIMENTOS
Fuel: não comprado • $900/1k
CO₂: não comprado • $200/1k

🛡️ SEGURANÇA
Segurança: quarentenas D3 R0 P0 S0 | UI healthy
```
Quando o dashboard registra `FIRST_PAGE_ONLY` ou `collectionComplete=false`, o Telegram **nunca afirma que a frota inteira foi verificada**. `SUCESSO` descreve o encerramento da execução, e não uma garantia de cobertura global. Os alertas operacionais são apresentados em linhas separadas, sem ocultar falhas de segurança.

O resumo não deve incluir:

- aircraftId;
- matrícula quando desnecessária;
- e-mail ou senha;
- tokens;
- cookies;
- HTML bruto;
- conteúdo de formulários;
- outros dados sensíveis da sessão.

## Proxima janela de combustivel no Telegram

Quando existir um preco futuro de referencia abaixo ou igual ao teto efetivo nas proximas 24 horas, o resumo apresenta uma linha `Proximo Fuel estimado` com data/hora UTC-3, preco de referencia por 1.000 lbs, preco live atual, `MAX_FUEL_PRICE`, eventual teto adaptativo, diferenca e percentual potencial.

Essa linha aparece tanto no resumo normal quanto no modo semiautomatico e **nao representa reserva de compra**. O calendario de referencia nao esta verificado (OCR), e o texto da notificacao explicita isso. Mesmo se o preco atual ja estiver dentro do teto, a compra segue as verificacoes habituais de estoque, caixa e interface. Sem horario listado, nao ha alerta de oportunidade para evitar falsas promessas.

## Alertas

O dashboard/notifier pode destacar:

- resultado incerto;
- fail-safe acionado;
- mudança inesperada de UI;
- reroute confirmado;
- bloqueio por Fuel;
- demanda esgotada;
- reanálise de rota disparada por demanda insuficiente;
- manutenção crítica;
- HOLD prolongado;
- campanha obrigatória não confirmada antes das decolagens.

## Diagnóstico do Telegram

### 403 — bot can't send messages to the bot

O Chat ID provavelmente aponta para o próprio bot. Use o ID da conversa ou grupo.

### chat not found

Verifique o Chat ID e se o bot possui acesso ao destino.

### sem updates

Abra a conversa e envie uma mensagem ao bot antes de consultar updates.

### timeout / network error

Trate como falha de transporte da notificação. O workflow usa notificação como etapa auxiliar e não deve reinterpretar uma operação saudável do jogo como falha apenas por causa do Telegram.


## Modo semiautomático

Quando o modo semiautomático está ativo, o Telegram prioriza um resumo curto de decisão, por exemplo:

```text
🟡 AM4 • MODO SEMIAUTOMÁTICO
Prontas: 13 | em voo: 7 | frota: 20
Demanda: 11/13 suficientes
Fuel: $420/1k | CO₂: $88/1k
Pricing: 4 ajustes sugeridos
Rotas: 2 candidata(s) a reroute
Nenhuma operação foi executada.
```

A mensagem inclui um botão **Abrir GitHub Actions**. Esse botão apenas abre o workflow; ele não executa o bot.

Para autorizar operações reais, o usuário inicia uma run manual e marca a confirmação do modo semiautomático. A confirmação vale somente para aquela run.

## CAPTCHA e challenges

Se uma verificação interativa, CAPTCHA ou challenge de segurança for detectado:

- a run é interrompida;
- nenhuma tentativa de solução ou contorno é feita;
- é criado `challenge-detected.json`;
- o Telegram informa que a execução foi interrompida por challenge.

A presença de challenge nunca é tratada como erro de UI comum que deva receber retry automático.

## Rotas compartilhadas e valor das decolagens

O resumo do Telegram lista `Rotas compartilhadas` quando **aeronaves diferentes, com IDs de aeronave e de rota distintos**, estão na mesma ligação **direcional** (ex.: GRU→BSB). Exibe suas matrículas. Essa situação comercial é normal e **não bloqueia decolagens por si só**; demanda, reservas de outros aviões, combustível, marketing e confirmação nativa continuam obrigatórios.

A repetição do **mesmo ID de rota ou aeronave na paginação** é outro caso, de possível leitura duplicada. Nunca é tratada como uma aeronave adicional. Uma navegação de leitura pode prosseguir com recuperação controlada, mas mutações continuam condicionadas a inventário completo com N rotas e N aeronaves únicas; uma identidade incerta mantém HOLD.

A linha `Receita bruta estimada das decolagens` soma somente **partidas confirmadas** e usa passageiros **embarcados observados após a decolagem** multiplicados pelas tarifas **lidas imediatamente antes da partida**. Não representa o extrato Finance, lucro, receita líquida ou valor contábil confirmado. Se faltar a tarifa de qualquer partida confirmada, o Telegram exibe `n/d`, nunca inventa ou substitui silenciosamente por zero. O valor estimado por aeronave fica em `execution-report.json`.

**Estratégia por página:** a coleta do Fleet já percorre páginas de maneira somente leitura; executar partidas enquanto as páginas posteriores ainda são desconhecidas não está habilitado, porque comprometeria o inventário completo, as reservas compartilhadas de demanda e os limites de combustível. Os resultados continuam persistidos antes de cada clique de partida, e o relatório final é gerado a partir das confirmações reais.
