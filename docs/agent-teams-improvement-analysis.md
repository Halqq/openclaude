# Análise de Melhorias — Sistema de Teammates

## Visão Geral

Este relatório cobre problemas de **segunda camada** do sistema de teammates: não a comunicação via mailbox (já coberta em `agent-teams-communication-analysis.md`), mas sim a execução, gerenciamento de recursos, sincronização de estado e observabilidade dos próprios processos de teammate.

### Áreas Analisadas

| Arquivo | Responsabilidade |
|---|---|
| `src/utils/swarm/inProcessRunner.ts` | Loop principal de execução in-process |
| `src/utils/swarm/spawnInProcess.ts` | Spawn e kill de teammates in-process |
| `src/utils/swarm/teamHelpers.ts` | Operações no `config.json` da equipe |
| `src/utils/teamMemoryOps.ts` | Leitura/escrita na team memory compartilhada |
| `src/services/teamMemorySync/teamMemSecretGuard.ts` | Proteção de segredos na memory |
| `src/utils/swarm/reconnection.ts` | Lógica de reconexão de sessions |
| `src/utils/swarm/backends/TmuxBackend.ts` | Backend tmux (spawn, panes, kill) |
| `src/utils/swarm/leaderPermissionBridge.ts` | Ponte de permissões leader↔worker |
| `src/utils/swarm/permissionSync.ts` | Sincronização de permissões via mailbox |
| `src/utils/tasks.ts` | CRUD de tarefas e claim/assignment |
| `src/tasks/InProcessTeammateTask/InProcessTeammateTask.ts` | Gerenciamento de estado de task |

---

## Problemas Identificados

### 1. Memory Leak: `setInterval` de Permission Polling Nunca Finalizado (SEVERIDADE: ALTA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`

O fallback de polling para permission requests usa `setInterval`. Quando a resposta chega, o código chama `processMailboxPermissionResponse()` e retorna — mas **nunca chama `cleanup()`**, que é a função responsável por `clearInterval`:

```
permResp encontrada → processMailboxPermissionResponse() → return
                                ↑
                        cleanup() nunca chamado!
```

O interval continua disparando a cada 500ms indefinidamente após a resposta ser processada. Em equipes com múltiplos teammates fazendo múltiplas permission requests ao longo de uma sessão longa, dezenas de intervals ficam ativos em paralelo, cada um lendo o mailbox periodicamente e consumindo I/O e CPU.

---

### 2. Race Condition: Cleanup Duplo no Abort do Permission Polling (SEVERIDADE: ALTA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`

No mesmo `setInterval` de permission polling, `cleanup()` pode ser chamada por dois caminhos concorrentes:

1. O listener `onAbortListener` (registrado via `abortController.signal.addEventListener`) dispara quando o abort ocorre
2. O callback do próprio `setInterval` detecta `abortController.signal.aborted === true` no próximo tick e também chama `cleanup()`

Se o abort acontece exatamente enquanto o callback do interval está em execução, ambos os caminhos chegam a `cleanup()` no mesmo event loop. Além de `clearInterval` ser chamado duas vezes, `unregisterPermissionCallback` é invocado duplo — o que pode corromper o mapa de callbacks pendentes se a implementação não for idempotente.

---

### 3. Race Condition: `setMemberActive` e `setMemberMode` Sem Lock (SEVERIDADE: ALTA)

**Arquivo envolvido:** `src/utils/swarm/teamHelpers.ts`

`setMemberActive` e `setMemberMode` seguem o padrão lê-modifica-escreve no `config.json` **sem nenhum mecanismo de lock**, ao contrário do mailbox (que usa `proper-lockfile`):

```
Thread A: readTeamFileAsync() → modifica campo A → writeTeamFileAsync()
Thread B: readTeamFileAsync() → modifica campo B → writeTeamFileAsync()
                                                         ↑
                                              Sobrescreve mudança de A!
```

Quando múltiplos teammates enviam `idle_notification` simultaneamente (cenário descrito no problema 1 do relatório de comunicação), cada um chama `setMemberActive(teamName, name, false)`. A última escrita vence, podendo deixar um ou mais membros com `isActive` errado. O leader enxerga uma equipe em estado divergente da realidade.

---

### 4. Sem Timeout: `waitForNextPromptOrShutdown` Pode Rodar Indefinidamente (SEVERIDADE: MÉDIA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`

O loop de espera de um teammate in-process por novos prompts ou shutdown é um `while` infinito sem nenhum timeout de inatividade:

```typescript
while (!abortController.signal.aborted) {
  await sleep(POLL_INTERVAL_MS)  // 500ms
  // verifica AppState por novas mensagens...
}
```

Se o `abortController` nunca for abortado (bug no leader, crash parcial, ou state inconsistente), o loop continua rodando para sempre. Em ambientes com limites de recursos (containers com memory limits, CI/CD com timeouts globais), teammates parados consomem slots de thread e alocam referências a `getAppState`/`setAppState`, impedindo a liberação de memória.

---

### 5. Race Condition: `pendingUserMessages` Pode ser Consumido Duas Vezes (SEVERIDADE: MÉDIA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`

O loop lê `pendingUserMessages[0]` **antes** de remover a mensagem do AppState:

```
1. Lê task.pendingUserMessages[0]  (snapshot)
2. setAppState: slice(1) para remover
3. Usa a mensagem lida no passo 1
```

Entre os passos 1 e 2, o React pode re-renderizar e `setAppState` de outro lugar pode atualizar a task. Se o `setAppState` do passo 2 receber um `prev` onde `pendingUserMessages` já estava diferente (por outra atualização concorrente), o índice 0 do slice errado pode deixar a mensagem na fila — ou, no sentido inverso, se a mensagem for adicionada e removida por duas operações de `setAppState` em conflito, pode nunca ser entregue.

---

### 6. Deadlock Potencial: Locks Aninhados em `claimTaskWithBusyCheck` (SEVERIDADE: MÉDIA)

**Arquivo envolvido:** `src/utils/tasks.ts`

`claimTaskWithBusyCheck` adquire o lock da lista de tasks e, enquanto ainda o segura, chama `updateTask`, que adquire um lock próprio sobre o arquivo individual da task:

```
claimTaskWithBusyCheck:
  lock(lista-lock)
    └─ updateTask:
         lock(task-file-lock)  ← lock aninhado!
```

Se em outro caminho de código a ordem for invertida (lock no arquivo da task → lock na lista), os dois caminhos podem entrar em deadlock clássico. `proper-lockfile` tem retries mas não tem timeout absoluto — um deadlock esgotaria todos os retries e lançaria uma exceção, mas durante os retries o caminho inteiro fica bloqueado por vários segundos.

---

### 7. Escalabilidade: Criação de Panes Tmux é Estritamente Serial (SEVERIDADE: MÉDIA)

**Arquivo envolvido:** `src/utils/swarm/backends/TmuxBackend.ts`

`acquirePaneCreationLock()` usa uma fila de Promises em memória que serializa **toda** criação de pane, uma por vez:

```typescript
let paneCreationLock: Promise<void> = Promise.resolve()  // lock global único

function acquirePaneCreationLock() {
  let release: () => void
  const newLock = new Promise<void>(r => { release = r })
  const previous = paneCreationLock
  paneCreationLock = newLock
  return previous.then(() => release!)
}
```

Spawnar N teammates resulta em tempo total de `N × tempo_de_criacao_de_pane`. Com panes levando ~400-600ms cada, uma equipe de 10 teammates leva ~5 segundos só para criar os panes. Uma equipe de 50 levaria ~25 segundos. Um pool com paralelismo limitado (ex: 4 panes simultâneos) reduziria isso a `ceil(50/4) × 600ms ≈ 8s`.

---

### 8. Falha Silenciosa: `readMailbox` em Permission Polling Sem try/catch (SEVERIDADE: MÉDIA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`

O callback do `setInterval` de permission polling não tem `try/catch` ao redor de `readMailbox()`. Se o arquivo de inbox for temporariamente inacessível (lock file stale, permissão negada, disco cheio), a exception propaga para dentro de um `async` callback de `setInterval` — que em Node.js, como não há handler, é **silenciosamente descartada**. O interval para de executar sem aviso. A permission request fica pendurada para sempre, e o teammate aguarda indefinidamente uma resposta que nunca virá.

---

### 9. Team Memory: Escritas Concorrentes Sem Proteção (SEVERIDADE: MÉDIA)

**Arquivos envolvidos:** `src/utils/teamMemoryOps.ts`, `src/services/teamMemorySync/teamMemSecretGuard.ts`

As operações de escrita na team memory (`writeTeamMemory`, `appendTeamMemory`) não usam nenhum lock equivalente ao `proper-lockfile` do mailbox. Quando dois teammates escrevem na memory simultaneamente:

- A última escrita vence silenciosamente (last-write-wins)
- Não há detecção de conflito nem merge
- Não há versionamento ou campo de timestamp por entrada que permita detectar sobreposição

O `teamMemSecretGuard` previne vazamento de segredos ao filtrar o conteúdo antes da escrita, mas não interfere no controle de concorrência — não há coordenação entre o guard e o mecanismo de escrita.

---

### 10. Sem Timeout: `destroyWorktree` Pode Bloquear o Shutdown (SEVERIDADE: MÉDIA)

**Arquivo envolvido:** `src/utils/swarm/teamHelpers.ts`

`cleanupSessionTeams` chama `destroyWorktree` para cada worktree de teammate ao encerrar a sessão. Internamente, `destroyWorktree` executa `git worktree remove --force` e, em fallback, `rm -rf` — ambos sem timeout. Em sistemas com filesystem lento, repositórios grandes, ou git travado por outro processo, o cleanup pode bloquear indefinidamente. Isso afeta principalmente:

- Shutdown manual do leader (`Ctrl+C`)
- Pipelines CI/CD com timeout global
- Sessões reiniciadas rapidamente (o cleanup da sessão anterior ainda rodando interfere com a nova)

---

### 11. Observabilidade: Ausência de Logging Estruturado e Correlação (SEVERIDADE: MÉDIA)

**Arquivos envolvidos:** Todos (uso extensivo de `logForDebugging`)

Todo o sistema usa `logForDebugging(string)` — uma função de texto livre sem:

- **Nível de severidade** (`error`, `warn`, `info`, `debug`)
- **Contexto estruturado** (IDs de equipe, teammate, request, task)
- **Timestamps explícitos** nos logs (os que existem são wall-clock sem monotonic)
- **Correlation IDs** para rastrear um fluxo (ex: permission request → response) entre componentes

Em cenários de falha (timeout, race condition, message loss), é praticamente impossível reconstruir a ordem exata de eventos a partir dos logs atuais. Erros que "deveriam" aparecer frequentemente são capturados em `try/catch` e apenas logados em debug, tornando-os invisíveis em produção.

---

### 12. Edge Case: Teammate Reconectado Pode Receber Mensagens Duplicadas (SEVERIDADE: BAIXA-MÉDIA)

**Arquivo envolvido:** `src/utils/swarm/reconnection.ts`

Quando uma sessão é retomada via `--resume` ou `/resume`, `initializeTeammateContextFromSession` reconstrói o contexto do teammate. O mailbox não é limpo antes da reconexão — mensagens que foram marcadas como `read: false` na sessão anterior (e nunca processadas porque a sessão morreu) ainda estão no inbox. Na próxima poll do `useInboxPoller`, elas são lidas novamente e entregues ao modelo como se fossem novas.

Dependendo do tipo de mensagem (permission request, shutdown request, idle notification), isso pode causar comportamentos inesperados: o model age como se estivesse recebendo uma nova instrução quando na verdade era contexto da sessão anterior.

---

### 13. Resource Leak: `allMessages` Cresce Ilimitadamente por Sessão (SEVERIDADE: BAIXA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`

A variável local `allMessages` acumula **todas** as mensagens de todos os prompts processados pelo teammate durante sua vida útil. O mecanismo de compaction reduz o contexto enviado à API, mas não reduz o array em si — apenas cria um contexto reduzido para envio. Para teammates de longa duração processando muitos prompts, `allMessages` pode crescer para centenas de MB retidos em memória, multiplicado pelo número de teammates concorrentes.

---

### 14. Edge Case: `onIdleCallbacks` Pode Vazar Se Callback Lançar Exceção (SEVERIDADE: BAIXA)

**Arquivo envolvido:** `src/utils/swarm/inProcessRunner.ts`, `src/utils/swarm/spawnInProcess.ts`

`onIdleCallbacks` é disparado via `Array.forEach`:

```typescript
task.onIdleCallbacks?.forEach(cb => cb())
```

Se qualquer `cb()` lançar uma exceção não tratada, o `forEach` interrompe na posição do erro — os callbacks seguintes nunca são chamados. O array é então limpo (`onIdleCallbacks: []`), então os callbacks perdidos nunca serão executados. Qualquer `waitForTeammatesToBecomeIdle` aguardando um desses callbacks ficará preso até o timeout (agora corrigido no ponto 4 do relatório anterior).

---

## Recomendações

### Curto Prazo

1. **Corrigir memory leak do permission polling** — adicionar `cleanup()` no caminho de sucesso (`processMailboxPermissionResponse` encontrada), e envolver o callback em `try/catch` para evitar que erros de I/O encerrem o interval silenciosamente

2. **Adicionar lock em `setMemberActive` / `setMemberMode`** — usar o mesmo `proper-lockfile` já presente no sistema, aplicado ao `config.json` da equipe, para serializar escritas concorrentes

3. **Timeout em `waitForNextPromptOrShutdown`** — adicionar timeout de inatividade (ex: 2 horas) para auto-encerrar teammates fantasma que nunca recebem mensagens nem abort

4. **Envolver callbacks de `onIdleCallbacks` em try/catch** — garantir que uma exceção em um callback não impeça os demais de executar:
   ```
   for (const cb of task.onIdleCallbacks ?? []) {
     try { cb() } catch { /* log */ }
   }
   ```

### Médio Prazo

5. **Adicionar lock na team memory** — aplicar o mesmo mecanismo de `proper-lockfile` do mailbox às operações de escrita em `teamMemoryOps.ts`

6. **Paralelizar criação de panes no TmuxBackend** — substituir o lock global serial por um pool com paralelismo limitado (ex: 4 panes simultâneos)

7. **Timeout em `destroyWorktree`** — envolver `git worktree remove` e `rm -rf` com timeout explícito (ex: 30s) para não bloquear shutdown

8. **Limpar inbox na reconexão** — ao retomar uma sessão via `--resume`, marcar como lidas (ou descartar) mensagens pendentes de protocolo (`shutdown_request`, `permission_request`) do inbox da sessão anterior

### Longo Prazo

9. **Logging estruturado** — substituir `logForDebugging(string)` por um logger com níveis, contexto estruturado (JSON) e correlation IDs por request/sessão, permitindo rastrear fluxos completos em produção

10. **Limite de tamanho em `allMessages`** — além de compactar o contexto enviado à API, descartar mensagens antigas do array local quando ultrapassar um threshold (ex: 200 mensagens), mantendo apenas contexto recente para `getLastPeerDmSummary` e similares

---

## Resumo de Severidades

| # | Problema | Severidade | Categoria |
|---|---|---|---|
| 1 | `setInterval` de permission nunca finalizado | ALTA | Memory Leak |
| 2 | Cleanup duplo no abort do permission polling | ALTA | Race Condition |
| 3 | `setMemberActive`/`setMemberMode` sem lock | ALTA | Race Condition |
| 4 | `waitForNextPromptOrShutdown` sem timeout de inatividade | MÉDIA | Timeout Ausente |
| 5 | `pendingUserMessages` pode ser consumido duas vezes | MÉDIA | Race Condition |
| 6 | Locks aninhados em `claimTaskWithBusyCheck` | MÉDIA | Deadlock Potencial |
| 7 | Criação de panes tmux estritamente serial | MÉDIA | Escalabilidade |
| 8 | Permission polling sem tratamento de erro em I/O | MÉDIA | Falha Silenciosa |
| 9 | Team memory sem proteção de concorrência | MÉDIA | Race Condition |
| 10 | `destroyWorktree` sem timeout | MÉDIA | Timeout Ausente |
| 11 | Ausência de logging estruturado e correlação | MÉDIA | Observabilidade |
| 12 | Teammate reconectado recebe mensagens duplicadas | BAIXA-MÉDIA | Edge Case |
| 13 | `allMessages` cresce ilimitadamente | BAIXA | Resource Leak |
| 14 | Exceção em `onIdleCallbacks` interrompe callbacks seguintes | BAIXA | Edge Case |

---

*Relatório gerado em 2026-04-07 — Análise de melhorias do sistema de execução de teammates*
