# Protótipo: fila por primeira página (somente leitura)

## Problema observado

Nas execuções reais #978–#983, o cabeçalho da lista indicava `Routes(142)`, mas a paginação retornou 141 pares de IDs exclusivos. Uma identidade da página anterior reapareceu na página nativa 6, e a última página mostrou dois registros em vez dos três ainda necessários. A captura fornecida pelo operador em 25/10/2026, às 09h54 (Brasília), confirmou que a aeronave `340-200-12` existe e estava voando DTW → DAC. Portanto, ausência na lista paginada **não significa exclusão**.

O jogo pode reordenar cartões após pousos, novas decolagens ou manutenção; a hipótese ainda precisa ser demonstrada na interface Fleet. O total `Routes(N)` pode não se alterar quando uma aeronave muda de estado.

## Novo piloto isolado

`demand/rolling-first-page.ts` observa somente a **primeira janela nativa** sem seguir `Next`, sem abrir detalhes e sem clicar em partidas:

1. Abre Fleet através do controle nativo já verificado.
2. Lê o cabeçalho e no máximo 20 cartões visíveis.
3. Extrai as identidades usando o callback exato `fleet_details.php?id=...`, registro e routeId.
4. Classifica `ready`, `inflight` ou `unavailable`; não presume que toda aeronave indisponível está em manutenção.
5. Reconfere uma segunda amostra da página, inclusive a ordem e o estado de cada cartão.
6. Bloqueia o planejamento quando há mudança de estado/ordem, IDs duplicados, callbacks desconhecidos, cursor inesperado ou uma janela curta.
7. Mantém em memória somente os resultados terminais registrados: confirmados e incertos jamais voltam à lista de candidatos nessa mesma execução.

A API **nunca** retorna autorização de mutação: `mutationAuthorized: false`. `READ_ONLY_CANDIDATES` é apenas uma lista exploratória, não uma permissão para decolar.

### Ativação observacional

O diagnóstico é ativado automaticamente **somente quando a coleta integral falha**. Pode ser desativado com `DEMAND_FIRST_PAGE_PILOT=false`. Após a falha, o bot faz uma leitura extra limitada a 5 segundos da primeira página e registra `test-results/demand/first-page-pilot.json` e uma linha sanitizada `[FirstPagePilot]`. Mesmo com o diagnóstico ativo, nenhuma decolagem, compra, precificação ou rota passa a ser autorizada pelo piloto. Não é necessário executar manualmente o workflow nem usar credenciais para validar os testes unitários.

## Condições para uma etapa posterior de despacho gradual

Antes de ativar decolagens pela primeira página, devem ser demonstrados em testes e em observação real:

- Critério confiável de unicidade e de estabilidade dos cartões quando aeronaves chegam durante a execução.
- Pré-validação fresca do alvo (aircraftId, routeId, registro, origem/destino, capacidade, demanda e controle nativo), com novo bloqueio se algo mudar.
- Reconciliação de capacidade de combustível, orçamento total, demanda compartilhada por par de aeroportos, campanha exigida e limites de horário.
- Registro durável **antes** de cada clique, confirmação independente **depois**, quarentena de resultado incerto e nenhuma repetição de tentativa.
- Condição de progresso: partir uma aeronave **não garante** que outra apareça na primeira página. Quando a janela não evolui, não repetir indefinidamente nem supor que toda a frota foi processada.
- Garantia explícita de integridade do inventário completo. A observação de uma página não comprova as outras 122 aeronaves. Não marcar uma coleta parcial como completa e não utilizar IDs do inventário anterior como prova atual.

**Decisão de segurança:** a migração operacional ainda não está autorizada. A liberação deve ocorrer somente após prova de invariantes equivalentes aos controles existentes e aprovação dos testes e da CI. A `main` atual não deve ser afrouxada para contornar `141/142`.

## Testes

`tests/unit/rolling-first-page.spec.ts` cobre observação com 20 cartões, estados mistos, janela curta possivelmente afetada por manutenção, duplicações de rota/aeronave, callback de detalhes não reconhecido, mudança de fingerprint ao pousar/reordenar, e prevenção de reprocessamento de partidas confirmadas ou incertas. Todo tráfego HTTP externo é bloqueado nas fixtures do navegador.
