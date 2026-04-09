# Análise de Loops de Idle e Dessincronização de Status — Agent Teams

> **Data:** 2026-04-09
> **Modelo utilizado:** qwen3.6-plus (3 agentes especializados)
> **Escopo:** Sistema de Agent Teams — ciclo de vida, comunicação, shutdown e sincronização de status

---

## 1. Resumo Executivo

O sistema de Agent Teams apresenta **7 vulnerabilidades críticas** que causam os dois sintomas relatados:

1. **Loop de idle** — teammates ficam presos em estado idle sem que o líder consiga resgatá-los ou fazer shutdown
2. **Dessincronização de status** — o líder não possui visão precisa do estado real de cada teammate

As causas raiz são: ausência de timeout na resposta de shutdown, falta de heartbeat para teammates in-process, entrega de mensagens sem garantia (fire-and-forget via arquivo), ausência de detecção de deadlock nas tarefas, e protocolo de shutdown cooperativo sem override de emergência.

---

## 2. Arquitetura do Sistema

### 2.1 Criação de Times

- **Entry point:** `src/tools/TeamCreateTool/TeamCreateTool.ts`
- Gera IDs determinísticos via `formatAgentId(TEAM_LEAD_NAME, teamName)`
- Escreve `config.json` em `~/.claude/teams/{team_name}/`
- Registra time para limpeza de sessão via `registerTeamForSessionCleanup()`

### 2.2 Execução de Teammates

Dois modos de execução:

| Modo | Isolamento | Comunicação |
|------|-----------|-------------|
| **In-process** | `AsyncLocalStorage` + `AbortController` | Loop interno com `waitForNextPromptOrShutdown()` (polling 500ms) |
| **Process-based** | tmux/iTerm2 panes (processos separados) | Hook Stop + heartbeat a cada 15s |

### 2.3 Sistema de Mensagens

- **Mailbox baseado em arquivos:** `~/.claude/teams/{team_name}/inboxes/{agente}.json`
- **Escrita:** `proper-lockfile` (10 retries, 5-100ms backoff) + loop externo (4 tentativas, delay 200ms × tentativa)
- **Leitura (líder):** React hook `useInboxPoller.ts` — intervalo de 1000ms
- **Leitura (in-process):** `waitForNextPromptOrShutdown()` — intervalo de 500ms
- **Tipos de mensagem:** IdleNotification, PermissionRequest/Response, ShutdownRequest/Approved/Rejected, Heartbeat, TaskAssignment, ModeSetRequest, PlanApprovalRequest

### 2.4 Protocolo de Shutdown

```
Líder → sendMessage(shutdown_request) → mailbox do teammate
Teammate → waitForNextPromptOrShutdown() detecta (prioridade sobre msgs normais)
Teammate → modelo decide approve/reject via tools
Teammate → shutdown_approved ou shutdown_rejected → mailbox do líder
Líder → usaInboxPoller processa → kill pane ou marca task completed
```

**Ponto crítico:** Shutdown é **cooperativo** — o modelo decide, não há aprovação automática.

### 2.5 Coordenação de Tarefas

- Arquivos JSON individuais em `~/.claude/tasks/{taskListId}/`
- `claimTaskWithBusyCheck()` — lock em dois níveis (task-list → task-file)
- Sistema de `blockedBy` para dependências entre tarefas
- High-water-mark previne reuso de IDs após reset

---

## 3. Problemas Identificados

### PROBLEMA 1: Sem Timeout na Resposta de Shutdown
**Severidade:** CRÍTICA

**Descrição:** O líder envia `shutdown_request` via `sendShutdownRequestToMailbox()` (`teammateMailbox.ts:891-923`) e não espera nem faz timeout na resposta. Se o teammate estiver travado em uma chamada de ferramenta longa ou em loop infinito, o request fica indefinidamente na mailbox sem ser lido.

**Arquivos afetados:**
- `src/utils/teammateMailbox.ts:891-923`
- `src/utils/swarm/inProcessRunner.ts:705-884`

**Impacto:** Líder não consegue determinar se o teammate recebeu/processou o shutdown. O time fica preso com membros "fantasmas".

---

### PROBLEMA 2: Sem Heartbeat para Teammates In-Process
**Severidade:** CRÍTICA

**Descrição:** Teammates baseados em processo enviam heartbeats a cada 15s com detecção de morte após 45s (3 heartbeats perdidos). Teammates in-process **não possuem heartbeat**. Se ficarem presos em loop infinito sem crashar, o líder não tem como detectar.

**Arquivos afetados:**
- `src/utils/swarm/inProcessRunner.ts` (todo o ciclo de vida)
- `src/hooks/useInboxPoller.ts` (dead teammate detection só funciona com heartbeats)

**Impacto:** Teammate in-process pode estar travado e o líder continua achando que está ativo.

---

### PROBLEMA 3: Entrega de Mensagens sem Garantia (Fire-and-Forget)
**Severidade:** ALTA

**Descrição:** `writeToMailbox()` tenta 4 vezes com lock. Se todas falharem (contenção alta sob carga de >10 agentes), a mensagem é **silenciosamente descartada**. Não há log de aviso, não há retry assíncrono, não há fila fallback.

**Arquivos afetados:**
- `src/utils/teammateMailbox.ts:46-47` (MAILBOX_WRITE_RETRIES)
- `src/utils/teammateMailbox.ts:36-42` (LOCK_OPTIONS)

**Impacto:** Notificações de idle, atribuições de tarefa, e respostas de shutdown podem ser perdidas sob carga.

---

### PROBLEMA 4: Sem Detecção de Deadlock em Tarefas
**Severidade:** ALTA

**Descrição:** O sistema de `blockedBy` permite dependências circulares. Se Task A bloqueia Task B e Task B bloqueia Task A, nenhuma será jamais executada. `findAvailableTask()` simplesmente ignora tarefas bloqueadas — não há verificação de ciclos.

**Arquivos afetados:**
- `src/utils/tasks.ts` (`findAvailableTask()`)
- `src/utils/swarm/inProcessRunner.ts:611-621`

**Impacto:** Lista de tarefas pode ficar permanentemente travada com dependências circulares.

---

### PROBLEMA 5: Sem Force Shutdown / Override de Emergência
**Severidade:** ALTA

**Descrição:** O protocolo de shutdown depende do modelo aprovar. Se o modelo recusar, alucinar, ou não reconhecer o protocolo, não há mecanismo de força bruta. Embora `killInProcessTeammate()` exista (AbortController direto), ele **não está conectado ao fluxo de shutdown** — é um caminho separado que precisa ser invocado manualmente.

**Arquivos afetados:**
- `src/utils/swarm/inProcessRunner.ts:705-884`
- `src/utils/swarm/spawnInProcess.ts` (`killInProcessTeammate()`)

**Impacto:** Se um teammate não coopera com shutdown, não há recuperação automática.

---

### PROBLEMA 6: Race Conditions no Sistema de Mensagens
**Severidade:** MÉDIA-ALTA

**Descrição:** Múltiplas race conditions identificadas:

| Race Condition | Descrição | Arquivo |
|---------------|-----------|---------|
| **pendingUserMessages** | read-before-slice pode perder/duplicar mensagens | `inProcessRunner.ts` |
| **Double cleanup** | Dois caminhos concorrentes para cleanup() no abort | `inProcessRunner.ts` |
| **onIdleCallbacks** | Exceção em um callback interrompe os restantes | `inProcessRunner.ts` |
| **Idle notification gap** | Líder pode checar entre "task marcada idle" e "notificação enviada" | `inProcessRunner.ts` + `useInboxPoller.ts` |
| **Task claim race** | Dois teammates vendo mesma tarefa como disponível antes do claim atômico | `tasks.ts` |

**Impacto:** Perda de mensagens, callbacks não executados, status inconsistente.

---

### PROBLEMA 7: Crescimento Ilimitado de Memória e Vazamentos
**Severidade:** MÉDIA

**Descrição:**

- `allMessages` cresce sem limite em memória (`inProcessRunner.ts`)
- `setInterval` no permission polling não é limpo no caminho de sucesso — memory leak
- Arquivos de inbox órfãos persistem em disco após término abrupto

**Arquivos afetados:**
- `src/utils/swarm/inProcessRunner.ts`
- `src/utils/swarm/teamHelpers.ts` (`setMultipleMemberModes()` sem locking)

**Impacto:** Degradação gradual de performance em sessões longas com muitos teammates.

---

## 4. Análise de Causa Raiz dos Loops de Idle

### Cenário 1: Teammate In-Process Travado

```
Teammate executa tarefa → entra em loop infinito (bug, alucinação do modelo)
→ Nunca chama onIdleCallback
→ Nunca envia idle_notification
→ Líder continua esperando (sem heartbeat para detectar)
→ Líder envia shutdown_request → fica na mailbox não lida
→ Sem timeout de shutdown → líder também fica esperando
→ DEADLOCK: ambos esperando indefinidamente
```

**Causa raiz:** Combinação dos Problemas 1, 2 e 5.

### Cenário 2: Mensagem de Idle Perdida

```
Teammate completa tarefa → marca task como idle → tenta enviar idle_notification
→ writeToMailbox() falha após 4 retries (contenção)
→ Notificação é perdida silenciosamente
→ Líder não sabe que teammate está idle
→ Líder continua aguardando resposta que já foi dada
→ Teammate entra em waitForNextPromptOrShutdown() → só sai com nova mensagem
→ LOOP: teammate idle esperando, líder esperando teammate
```

**Causa raiz:** Problema 3 (entrega sem garantia).

### Cenario 3: Dependências Circulares de Tarefas

```
Teammate A completa → procura próxima tarefa → todas disponíveis estão blockedBy outras
→ Tarefa X blockedBy Y, Tarefa Y blockedBy X
→ Nenhum teammate consegue executar X ou Y
→ Todos os teammates ficam idle
→ Líder não consegue redistribuir (todas as tarefas estão bloqueadas)
→ LOOP: todos idle, nenhuma tarefa executável
```

**Causa raiz:** Problema 4 (sem detecção de deadlock).

---

## 5. Análise de Dessincronização de Status

### Por que o Líder Não Tem Visão Real do Teammate

| Causa | Mecanismo | Consequência |
|-------|-----------|--------------|
| **Polling-based apenas** | Sem streaming real-time; gaps de 500ms-1000ms | Status pode estar desatualizado por até 1 segundo |
| **Sem acknowledgment** | Mensagens que não são shutdown não têm ACK | Líder não sabe se teammate recebeu a mensagem |
| **Sem query de status** | Não existe "o que o teammate X está fazendo agora?" | Líder só vê o que está na task list, não o estado interno |
| **In-memory vs file** | In-process checa mensagens em memória primeiro, depois arquivo | Se dessincronizam, status fica inconsistente |
| **Sem números de sequência** | Mensagens sem ordering além de FIFO no arquivo | Mensagens podem ser processadas fora de ordem sob contenção |
| **Heartbeat ausente (in-process)** | Só process-based tem heartbeat | Líder não detecta teammates in-process travados |

### Fluxo de Dessincronização Típico

```
1. Líder atribui tarefa ao Teammate A via mailbox
2. Mailbox write falha (contenção) → mensagem perdida
3. Líder acha que Teammate A está trabalhando
4. Teammate A está idle (nunca recebeu a tarefa)
5. Líder espera timeout (30s em waitForTeammatesToBecomeIdle)
6. Após timeout, líder marca como problema mas não sabe a causa
7. Task list mostra "in_progress" para Teammate A (stale)
8. Próximas tarefas não são atribuídas porque líder acha que A está ocupado
```

---

## 6. Recomendações Prioritizadas

### P0 — Críticas (implementar imediatamente)

| # | Recomendação | Resolve |
|---|-------------|---------|
| 1 | **Adicionar timeout de resposta de shutdown** (ex: 30s) com fallback para force-terminate via AbortController | Problema 1, Cenário 1 |
| 2 | **Adicionar heartbeat para teammates in-process** (mesmo intervalo de 15s/45s dos process-based) | Problema 2, Cenário 1 |
| 3 | **Adicionar tipo `force_shutdown`** que bypassa decisão do modelo e aborta diretamente via AbortController | Problema 5, Cenário 1 |

### P1 — Altas (próxima sprint)

| # | Recomendação | Resolve |
|---|-------------|---------|
| 4 | **Detecção de deadlock em tarefas** — topological sort ao criar/scannear tarefas; auto-desbloquear ou notificar líder | Problema 4, Cenário 3 |
| 5 | **Garantia de entrega de mensagens** — log de warning quando writes falham, retry assíncrono, ou fila fallback | Problema 3, Cenário 2 |
| 6 | **Ack para mensagens não-shutdown** — mecanismo simples de confirmação de recebimento | Problema 6, Dessincronização |

### P2 — Médias (backlog)

| # | Recomendação | Resolve |
|---|-------------|---------|
| 7 | **Números de sequência nas mensagens** para garantir ordenação correta | Dessincronização |
| 8 | **Limpar arquivos de inbox órfãos** durante team deletion | Problema 7 |
| 9 | **Corrigir memory leaks** — clearInterval no permission polling, limitar allMessages, try/catch em onIdleCallbacks | Problema 7 |
| 10 | **Locking em setMultipleMemberModes()** — atualmente sem proper-lockfile | Problema 7 |

---

## 7. Arquivos Relevantes

| Arquivo | Descrição |
|---------|-----------|
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | Criação de times e registro de membros |
| `src/utils/swarm/teamHelpers.ts` | Operações de config do time (setMemberActive, setMemberMode) |
| `src/utils/swarm/inProcessRunner.ts` | Ciclo de vida de teammates in-process, idle handling, shutdown |
| `src/utils/swarm/spawnInProcess.ts` | Spawn e kill de teammates in-process |
| `src/utils/swarm/teammateInit.ts` | Hooks de inicialização de teammates process-based |
| `src/utils/teammateMailbox.ts` | Protocolo de mailbox (shutdown, heartbeat, permissões) |
| `src/hooks/useInboxPoller.ts` | Polling de inbox do líder (React hook, 1000ms) |
| `src/utils/tasks.ts` | CRUD de tarefas e claim atômico |
| `src/utils/swarm/teammate.ts` | waitForTeammatesToBecomeIdle() com timeout de 30s |
| `src/utils/gracefulShutdown.ts` | Shutdown a nível de processo com failsafe timers |
| `src/tools/TaskUpdateTool/TaskUpdateTool.ts` | Atualização de tarefas e envio de task_assignment |
| `src/utils/collapseTeammateShutdowns.ts` | Batching de notificações de shutdown na UI |
| `src/hooks/notifs/useTeammateShutdownNotification.ts` | Folding de notificações de shutdown na UI |
| `src/utils/lockfile.ts` | Wrapper lazy para proper-lockfile |
| `src/utils/swarm/permissionSync.ts` | Sync de permissões via mailbox |

---

## 8. Conclusão

Os loops de idle e a dessincronização de status são sintomas de **falhas sistêmicas no design de confiabilidade** do sistema de Agent Teams. O sistema assume que:

1. Mensagens sempre serão entregues (não são — falha silenciosa após 4 retries)
2. Teammates sempre responderão a shutdown (não respondem — sem timeout, sem heartbeat in-process)
3. Tarefas nunca terão dependências circulares (têm — sem detecção)
4. O modelo sempre tomará decisões corretas sobre shutdown (nem sempre — sem force override)

A implementação das recomendações P0 resolveria a maioria dos casos de loop de idle relatados. As P1 eliminariam a dessincronização de status. As P2 melhorariam a robustez geral do sistema.
