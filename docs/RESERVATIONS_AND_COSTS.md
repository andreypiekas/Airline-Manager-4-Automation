# Reservas e custos de candidatos

Route research precisa separar **dados observados** de **estimativas**. Este documento define os limites usados para preparar comparações econômicas.

## Reservas de demanda

Quando mais de uma aeronave pode consumir o mesmo pool, o planejador não pode atribuir a demanda integral a todas elas.

O horizonte é configurado por:

```text
ROUTE_RESERVATION_NEXT_LEGS
ROUTE_RESERVATION_POOL_SCOPE
```

O padrão conservador trabalha por par de aeroportos.

Uma reserva de planejamento:

- não altera a demanda do jogo;
- não é prova de embarque futuro;
- existe apenas para evitar dupla contagem na comparação.

## Demanda de candidatos

Demanda de referência, tabelas estáticas ou sugestões de rota não substituem o saldo atual necessário para uma mutação real.

Se a demanda efetiva de uma candidata não puder ser demonstrada, o componente permanece indisponível e a comparação não fica pronta para execução.

## Custos

Os custos são separados por componente. Entre os grupos utilizados pelo modelo estão:

- Fuel;
- CO₂;
- A-check;
- reparos/desgaste;
- aeroporto;
- staff;
- marketing;
- outros recorrentes;
- setup/criação da rota.

Valores ausentes não recebem zero automático.

## Evidência

Uma entrada econômica só pode contribuir para autorização quando:

- a unidade é conhecida;
- o valor é finito e não negativo;
- a fonte é compatível com o componente;
- a observação está vinculada ao contexto correto;
- a idade da evidência está dentro do limite aplicável.

Referências de catálogo podem ser úteis para diagnóstico, mas não substituem um custo efetivo quando o comparador exige evidência operacional.

## Flight History e finanças

Históricos observados podem ajudar a calibrar:

- consumo conhecido de Fuel;
- passageiros embarcados;
- continuidade de ciclos;
- referências financeiras.

Eles não provam sozinhos o custo futuro completo de uma rota.

Dados agregados como salários, marketing ou manutenção em lote não são automaticamente rateados por aeronave/trecho sem uma política comprovada.

## Comparison readiness

Uma candidata só deve alcançar `comparisonReady=true` quando todos os componentes obrigatórios daquela comparação estiverem suficientemente verificados.

Se qualquer dimensão crítica estiver ausente, o resultado correto é `HOLD`, não uma estimativa otimista.


## Calibracao recente conservadora de CO2

O fator de CO2 exibido numa cotacao atual precisa ser corroborado por consumos do historico real de voos; nunca pela demanda estatica de um catalogo.

Quando a regressao historica completa e instavel apos mudancas operacionais, o bot pode avaliar UMA segunda janela fixa: os oito voos mais recentes, consecutivos, ordenados por idade relativa e dentro das ultimas 24 horas. A janela nunca pode pular uma linha sem distancia comprovada ou historico incompleto.

A regressao recente continua exigindo os mesmos limites rigorosos: fator compativel com o arredondamento do jogo, intercepto nao negativo, erro e residuo baixos, variacao de ocupacao suficiente e composicao de cabine verificavel. Se os oito voos mais recentes divergirem do fator live, a calibracao permanece indisponivel e nao autoriza troca.

Os campos fitScope e fitSamplesUsed identificam a janela utilizada. A serie completa permanece no diagnostico para auditoria. Isto NAO contorna os criterios separados de demanda restante, reservas, custos e seguranca de mutacao.
