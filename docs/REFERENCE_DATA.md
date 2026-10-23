# Dados de referência

O diretório `data/reference/` contém catálogos e referências estáticas usadas para cruzamentos, diagnóstico e pesquisa.

> [!IMPORTANT]
> Dados estáticos **não autorizam mutações**. Produção depende de observações live e dos gates de cada módulo.

## Aeroportos

`airports.json` contém o catálogo usado para converter IDs nativos observados no AM4 em códigos IATA quando a correspondência é única e não conflitante.

Esse catálogo suporta a descoberta dinâmica de hubs.

## Aeronaves e rotas

Referências de modelos e rotas podem ser usadas para:

- validar alcance;
- organizar candidatos;
- comparar identificadores;
- produzir diagnósticos;
- orientar pesquisa.

Elas não substituem:

- demanda restante;
- Auto Price atual;
- custos operacionais atuais;
- estado real da aeronave;
- controles nativos da interface.

Uma lista de candidatos baseada em referência não é garantia de melhor rota global.

## Descoberta independente das sugestões do jogo

A pesquisa read-only `optimization/reference-discovery.ts` usa o catálogo
`routes.json` por inteiro, com filtros de alcance, pista e demanda estática,
para listar até 20 possibilidades por aeronave. Os arquivos
`reference-report.json` (campo `catalogDiscovery`) e
`catalog-discovery.md` informam a cobertura de cada base, inclusive quando
não existem dados suficientes. Nenhum resultado significa melhor rota global:
a pesquisa não substitui os dados live e não autoriza alterações.

## Fuel e CO₂

Calendários de preço armazenados em `data/reference/` são somente referência.

O módulo de compra exige preço live. Uma previsão, OCR ou tabela externa nunca substitui essa leitura.

## Pricing

Referências históricas ajudaram a validar os multiplicadores PAX implementados no código:

```text
Y = Auto × 1.10
J = Auto × 1.08
F = Auto × 1.06
```

A fonte operacional continua sendo o Auto Price observado na rota ativa.

## Referência de tarifas e receita potencial (abc8747/am4)

O `reference-report.json` acrescenta `communityPriceScenarios` às rotas candidatas, com tarifa
teórica Y/J/F para Easy e Realism e teto **bruto e hipotético** por partida, limitado pela
demanda estática diária do catálogo e assentos atuais. Esses números não representam
ocupação ou lucro esperado e não mudam a ordenação ou a autorização de nenhuma operação.
Veja [proveniência, cálculo e licença MIT](./AM4_COMMUNITY_ROUTE_PRICING.md).

## Reprodutibilidade

Quando scripts de importação forem usados, preserve:

- origem do arquivo;
- hash;
- schema produzido;
- conflitos encontrados;
- indicador de verificação.

OCR deve permanecer marcado como não verificado até conferência independente.

## Cadeia de autorização

Nenhuma referência estática deve, isoladamente, definir:

- `mutationAuthorized=true`;
- `comparisonReady=true`;
- autorização de compra;
- autorização de departure;
- autorização de reroute.
