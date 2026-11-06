# Auditoria de branches remanescentes — 06/11/2026

Base examinada: `main` em `e39ef2239ab2bd20cc9c090cc43ab8089031943d`.
Método: comparação de **todos os 19 heads não-operacionais** com `main`,
revisão de arquivos divergentes e dos PRs abertos #90, #91, #92 e fechado #110.
A presença de commits exclusivos não comprova que seja seguro mesclar o branch:
partes podem estar reimplementadas na main, ou conter guardas anteriores e menos seguros.

## Avaliação das 21 refs

| Branch/ref | Status em relação à main examinada | Encaminhamento |
| --- | --- | --- |
| `main` | Canonical | **Preservar** |
| `am4-runtime-state` | Estado/caderneta persistente independente do código | **Preservar incondicionalmente** |
| `migration-stable` | 0 à frente; snapshot histórico 418 commits atrás | Preservar como marco de migração, salvo política explícita de arquivamento |
| `snapshot/rolling-dispatch-pr83-source-1035` | 24 commits exclusivos, 33 atrás; implementação antiga de Fleet e rolling | **Preservar como snapshot técnico**, não mesclar sua versão do executor sobre a main |
| `audit/readonly-fleet-preview-20261021` | +4/-85; workflow só funciona com SHA de main fixo de 21/10 | Obsoleto/uso único; não mesclar workflow autenticado com SHA inválido |
| `fix/all-ready-details-timeout-green-1075-20261027` (PR #90) | +2/-25; bloqueio de falso verde em detalhes | **Reimplementar sobre a main** com testes, sem sobrescrever reconciliação atual |
| `fix/persist-state-after-cancelled-live-run-1081-20261027` (PR #91) | +2/-25; finalizer no cancelamento | **Reimplementar** o único ajuste de condition, conservando restore e guardas |
| `fix/run1127-unverifiable-demand-fail-closed` (PR #92) | +6/-25; sinalização de demanda indisponível, mas remove proteções recentes | **Extrair somente detector e falha final**; não mesclar branch inteira |
| `fix/maintenance-card-skip-fail-closed-705` | +1/-93; heurística de cor/número e seletor global | **Não mesclar**: comportamento menos seguro que a leitura estrita atual |
| `fix/telegram-evidence-first-summary-1330` (PR #110 fechado sem merge) | +3/-9; relatório anterior ao #109 | Revisar apenas ideias, **não mesclar**; formato principal já é mais recente |
| `fix/telegram-shared-routes-confirmed-reroute-20261018` e `fix/telegram-shared-routes-post-reroute-20261018` | 0 à frente | Completamente contidos em main; dispensáveis após verificação de ancestry |
| `fix/campaign-gate-false-success-725` | 0 à frente | Contido em main; dispensável |
| `fix/departure-fleet-fresh-retry-run677` e `fix/departure-fresh-retry-629` | 0 à frente | Contidos em main; dispensáveis |
| `fix/fuel-evidence-deadlock-status-823`, `fix/fuel-evidence-deadlock-status-852`, `fix/fuel-evidence-deadlock-status-860` | 0 à frente | Contidos em main; dispensáveis |
| `fix/fuel-evidence-operational-status-846`, `fix/fuel-evidence-operational-status-853-854`, `fix/fuel-evidence-zero-departures-status-858-859` | 0 à frente | Contidos em main; dispensáveis |

## Correções recuperadas

1. **#1075** — quando todos os alvos READY têm detalhes nativos indisponíveis, nenhum departure confirmado e somente holds de preparação sem demanda, marcar ciclo como incompleto. Não permitir retry.
2. **#1127** — no caminho alternativo de coleta integral, `evaluated>0`, `unavailable=evaluated` e `sufficient=insufficient=0` não significam demanda zero. Marcar falha antes de mutações posteriores.
3. **#1081** — permitir que o finalizador `always()` tente salvar estado após etapa do bot `cancelled`, **somente** com `state_restore.outcome == 'success'` e fora da simulação. O GitHub pode interromper o job antes do finalizador: essa mitigação não garante persistência em todos os cancelamentos.

## Próxima política de higiene

- Remover com segurança branches com `ahead_by=0` após revalidar que o HEAD atual ainda é ancestral da `main`; preservar `migration-stable` e `am4-runtime-state`.
- Somente encerrar PRs #90–#92 como substituídos **depois** que os testes da integração nova passarem e a main receber essas correções.
- Não excluir nem reaproveitar `snapshot/rolling-dispatch-pr83-source-1035` sem decisão explícita sobre retenção de snapshots.
- Manter o relatório de auditoria mesmo após eliminar refs obsoletas; o histórico de commits continuará acessível pelo GitHub enquanto houver referências históricas.

**Segurança:** nada nesta auditoria autoriza compras, decolagens, bypass de CAPTCHA, redução dos gates atuais ou exclusão da branch de runtime.
