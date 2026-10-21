# Fuel e CO₂

O módulo de supplies consulta os mercados do AM4 antes das fases principais da frota.

## Princípio

Toda decisão de compra depende do **preço observado ao vivo**.

Catálogos, calendários ou referências externas podem aparecer em relatórios, mas nunca autorizam compra.

## Configuração

| Variable | Padrão | Regra |
| --- | ---: | --- |
| `ENABLE_FUEL` | `true` | Controla Fuel e CO₂ |
| `MAX_FUEL_PRICE` | `550` | Teto máximo inclusivo por 1.000 lbs |
| `MAX_CO2_PRICE` | `120` | Teto máximo inclusivo por 1.000 quotas |
| `MAX_FUEL_PURCHASE_PER_RUN` | `0` | 0 usa espaço disponível |
| `MAX_CO2_PURCHASE_PER_RUN` | `0` | 0 usa espaço disponível |
| `MIN_CASH_RESERVE` | `0` | Caixa que deve permanecer disponível |

A igualdade ao teto **compra** se os demais gates também passarem. Ex.: `MAX_CO2_PRICE=120` permite 120; 121 já é bloqueado.

## Planejamento da quantidade

A quantidade é limitada por:

- espaço livre;
- limite por execução;
- caixa acima da reserva;
- orçamento conservador.

Quando a compra total planejada não cabe no caixa disponível, a política reduz a exposição em vez de consumir todo o saldo restante.

Déficit negativo de CO₂ não é usado automaticamente como justificativa para uma política não verificada.

## Execução

1. abrir o mercado;
2. ler preço, estoque, espaço e saldo;
3. calcular o plano;
4. obter a cotação nativa;
5. reler o snapshot antes do clique;
6. bloquear se preço/contexto mudaram;
7. persistir a intenção;
8. comprar pelo controle nativo;
9. reler estoque e pagamento;
10. confirmar o resultado.

Nenhuma chamada direta é usada como substituto do controle nativo observado.

## Proxima oportunidade de preco favoravel (Fuel)

A cada consulta do mercado, o relatorio informa a **proxima cotacao listada nas proximas 24 horas** que fique **menor ou igual ao teto efetivo de compra** de Fuel. Esse teto pode ser menor que `MAX_FUEL_PRICE` por politica adaptativa. Igualdade permite compra, desde que os demais requisitos sejam atendidos.

A comparacao inclui preco atual observado ao vivo, teto configurado, teto efetivo, diferenca por 1.000 lbs, percentual potencial e horario local UTC-3. O relatorio tambem identifica a cotacao mais barata listada na mesma janela, quando houver.

**Atencao:** o calendario integrado foi extraido de PDF e encontra-se marcado como `ocr-unverified`. Os precos e horarios futuros sao apenas **referencias nao verificadas**; podem estar errados, incompletos ou nao corresponder ao mercado atual. Nao e possivel garantir que o preco futuro ocorrera. O bot **nao espera nem agenda uma compra com base no calendario**: toda compra continua exigindo cotacao live, saldo, estoque e gates operacionais.

A informacao aparece em `supply-report.json/.md`, no dashboard e no resumo Telegram, sem enviar uma mensagem separada a cada reexecucao. Se nenhum horario elegivel for listado, nao inventa previsao nem extrapola para o proximo mes.

## Resultado incerto

Se uma compra foi tentada, mas o resultado não pôde ser confirmado:

- a run é interrompida;
- a operação não é repetida automaticamente;
- uma quarentena persistente é registrada quando o journal está habilitado.

## Relatórios

`supply-report.json/.md` registra:

- preço observado;
- teto efetivo;
- política adaptativa;
- quantidade planejada;
- resultado;
- razão do HOLD/skip;
- evidência pós-compra quando disponível.

O Summary exibe apenas a consolidação executiva.

## Reposição após decolagens (M3)

Após **um ciclo real de partidas inteiramente avaliado** e pelo menos uma partida confirmada, o executor pode reler os mercados de Fuel e CO₂ e completar novamente os estoques. Somente o preço e os dados **live** do jogo autorizam a operação; preços iguais aos tetos efetivos são permitidos.

A segunda fase não é executada se:
- a execução for simulada, não houver partidas confirmadas ou o despacho terminar incompleto por tempo/limite;
- uma partida ficar incerta, ou o relatório operacional estiver ausente/inconsistente;
- o suprimento inicial tiver resultado desconhecido/incompleto;
- faltar margem de tempo para comprar, confirmar e preservar o estado;
- os valores excederem o teto, reserva mínima de caixa ou limite **total por recurso e por execução** (compras antes + depois).

Não há compra em massa sem confirmação: cada recurso usa novamente o controle nativo, cotação e snapshot fresco do mercado, saldo e pagamento confirmados. Resultado incerto não é repetido. O segundo ciclo é exclusivo (`supplies-post.started`) e tem relatório independente `supply-post-report.json/.md`. O abastecimento inicial permanece em `supply-report.json/.md`.

A fase não tenta compensar um despacho incompleto nem alterar os bloqueios de demanda/fuel: aeronaves retidas por falta de demanda ou recursos continuam seguindo seus próprios gates. O fim da fase de decolagens apenas determina quando se pode reavaliar os mercados.
