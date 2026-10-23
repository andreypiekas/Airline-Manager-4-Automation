# AM4 Community — referência de tarifas e teto de receita

## Proveniência
- Projeto: https://github.com/abc8747/am4
- Fonte do cálculo: `am4/src/route/ticket.rs`
- Commit fixado: `d243dcd13d102b28a548b6346af62fbd62c7c9aa`
- Autor original: Abraham Cheung (2023), MIT License.
- Integração: `optimization/community-route-prices.ts`
- Artefato: `reference-report.json`, campo `communityPriceScenarios` de cada rota candidata.

## Como interpretar
É uma **estimativa diagnóstica**, não uma recomendação para salvar uma tarifa ou trocar uma rota.
Para cada aeroporto candidato, o relatório calcula valores referenciais de Y/J/F para
os dois modos do AM4 (easy e realism). O modo não é adivinhado. Também calcula um teto
de receita bruta para **uma decolagem hipotética**, com todos os assentos ocupados até
o limite da demanda estática registrada. Não é a previsão de receita real, não há
desconto de demanda consumida por outras aeronaves, nem custos, nem ajuste por horário,
ocupação histórica ou idade dos dados.

Mesmo que um valor pareça atrativo, **não** altera a ordenação de candidatos, os preços
nativos, a política KEEP/HOLD/REROUTE nem autoriza decolagem, troca de rota ou compra.
O Auto Price observado no jogo continua sendo a única referência operacional de pricing.
A validação econômica de rota permanece subordinada aos dados live completos.

## Aviso de licença do software adaptado

MIT License

Copyright (c) 2023 Abraham Cheung

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
