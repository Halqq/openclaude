# Analise do Sistema Agent Teams -- Problemas de Ciclo Ocioso e Dessincronizacao de Status

> Data: 2026-04-09
> Escopo: Sistema de equipes multi-agente (Agent Teams / Swarms)
> Base de codigo: `/Users/kaua/Projetos/openclaude`

---

## 1. Resumo Executivo

O sistema Agent Teams permite que um agente lider (`team-lead`) orquestre uma equipe de agentes subordinados (teammates), que podem ser executados **in-process** (mesmo processo Node.js com isolamento via `AsyncLocalStorage`) ou **baseados em paineis** (tmux/iTerm2 como processos separados). A comunicacao entre lider e subordinados ocorre inteiramente via **arquivos de mailbox** baseados em disco, sem garantia de entrega, sem numeracao de sequencia e sem mecanismo de ack para mensagens nao relacionadas a shutdown.

Foram identificados **8 problemas criticos** e **6 problemas de severidade media** que afetam diretamente a confiabilidade do ciclo de vida dos teammates, a precisao do status reportado ao lider e a resiliencia em cenarios de falha. Os problemas mais graves incluem: perda silenciosa de mensagens sob alta contencao, ausencia de watchdog para teammates in-process, ausencia de timeout para respostas de shutdown, e possibilidade de deadlock em dependencias circulares de tarefas.

---

## 2. Arquitetura do Sistema

### 2.1 Criacao de Equipes

- **Ponto de entrada**: `TeamCreateTool` (`src/tools/TeamCreateTool/TeamCreateTool.ts:74`)
- Escreve `config.json` em `~/.claude/teams/{nome_equipe}/` via `writeTeamFileAsync()` (`src/utils/swarm/teamHelpers.ts:184`)
- Estrutura do arquivo de equipe (`TeamFile`): membros, `leadAgentId`, `leadSessionId`, cores, modos de permissao, status ativo/idle (`teamHelpers.ts:73-99`)
- Registro para limpeza pos-sessao via `registerTeamForSessionCleanup()` (`teamHelpers.ts:612`)

### 2.1.1 Tipos de Spawn de Teammates

**In-process** (`src/utils/swarm/spawnInProcess.ts:104`):
- Cria `AbortController` independente por teammate
- Usa `AsyncLocalStorage` para isolamento de contexto (`createTeammateContext`)
- Execucao fire-and-forget via `startInProcessTeammate()` (`inProcessRunner.ts:1560`)
- Compartilha recursos (cliente API, conexoes MCP) com o lider

**Baseado em paineis** (`PaneBackendExecutor`, `src/utils/swarm/backends/PaneBackendExecutor.ts:39`):
- Cria painel via tmux/iTerm2 como processo separado
- Herda variaveis de ambiente e flags CLI do lider
- Comunicacao via mailbox de arquivos (mesmo mecanismo que in-process)

### 2.2 Sistema de Mensagens (Mailbox)

- **Arquivo de inbox**: `~/.claude/teams/{equipe}/inboxes/{agente}.json` (`teammateMailbox.ts:62`)
- **Escrita**: `writeToMailbox()` com lock de arquivo (`proper-lockfile`) + 4 tentativas de reescrita, 200ms de delay (`teammateMailbox.ts:140-216`)
- **Lock de arquivo**: 10 retries com backoff 5-100ms (`teammateMailbox.ts:36-42`)
- **Leitura pelo lider**: Hook React `useInboxPoller`, intervalo de 1000ms (`useInboxPoller.ts:108, 977`)
- **Leitura por in-process**: `waitForNextPromptOrShutdown()`, intervalo de 500ms (`inProcessRunner.ts:713`)

### 2.3 Deteccao de Estado Ocioso (Idle)

**In-process** (`inProcessRunner.ts:1327-1363`):
1. Apos cada iteracao de `runAgent()`, marca `isIdle: true` no estado da tarefa
2. Envia `idle_notification` via mailbox para o lider
3. Entra no loop `waitForNextPromptOrShutdown()` (poll a cada 500ms)

**Baseado em paineis** (`teammateInit.ts:118-148`):
1. Hook `Stop` dispara quando o loop do agente para
2. Envia `idle_notification` + atualiza `isActive: false` no `config.json`
3. **Heartbeat periodico**: a cada 15s envia mensagem `heartbeat` ao lider (`teammateInit.ts:104-115`)

**Deteccao de morte pelo lider** (`useInboxPoller.ts:982-1062`):
- Verifica a cada 5s se algum teammate perdeu heartbeats
- Timeout: 45s (3 x 15s) sem heartbeat = teammate considerado morto

### 2.4 Protocolo de Shutdown

1. Lider envia `shutdown_request` via mailbox (`teammateMailbox.ts:891-923`)
2. Teammate recebe a mensagem, passa ao modelo para decisao
3. Modelo responde com `shutdown_approved` ou `shutdown_rejected`
4. Lider processa aprovacao: mata o painel (`useInboxPoller.ts:700-823`)
5. Para in-process: `AbortController` e o mecanismo real de terminacao

---

## 3. Problemas Identificados

### PROBLEMA 1: Perda Silenciosa de Mensagens sob Alta Contenção

**Severidade**: CRITICA
**Arquivos afetados**: `src/utils/teammateMailbox.ts:170-216`

A funcao `writeToMailbox()` tenta adquirir o lock do arquivo com 10 retries (backoff 5-100ms). Se todas as tentativas de lock falharem, o loop externo de 4 tentativas de escrita tambem esgota e a mensagem e **descartada silenciosamente** -- nenhum log de erro e emitido para o usuario, apenas `logError()` assincrono que pode passar despercebido.

Em equipes com >10 agentes ativos simultaneamente, onde multiplos agentes enviam idle notifications, heartbeats e mensagens normais ao mesmo tempo, a contencao no lock do arquivo e inevitavel.

```typescript
// teammateMailbox.ts:212-216 -- falha silenciosa apos 4 tentativas
logForDebugging(
  `[TeammateMailbox] Failed to write to inbox for ${recipientName} after ${MAILBOX_WRITE_MAX_ATTEMPTS} attempts: ${lastError}`,
)
logError(lastError) // assincrono, nao bloqueante
```

### PROBLEMA 2: Race Condition na Notificacao de Idle (In-Process)

**Severidade**: ALTA
**Arquivos afetados**: `src/utils/swarm/inProcessRunner.ts:1334-1363`, `src/hooks/useInboxPoller.ts:149-162`

A sequencia de idle no in-process e:
1. `updateTaskState` marca `isIdle: true` (linha 1334)
2. Executa callbacks de idle (linha 1338)
3. **So entao** envia `idle_notification` via mailbox (linha 1350)

O lider faz poll do inbox a cada 1000ms. Se o poll ocorrer entre os passos 1 e 3, o lider nao vera a notificacao de idle. O estado `isIdle` no AppState e interno ao processo -- o lider so descobre o idle via mailbox. Se a notificacao de idle for perdida (Problema 1), o lider acredita que o teammate ainda esta ativo indefinidamente.

### PROBLEMA 3: Ausencia de Watchdog/Heartbeat para Teammates In-Process

**Severidade**: CRITICA
**Arquivos afetados**: `src/utils/swarm/inProcessRunner.ts`, `src/utils/swarm/spawnInProcess.ts:104-216`

Teammates baseados em paineis enviam heartbeats a cada 15s (`teammateInit.ts:104`). O lider verifica mortes a cada 5s (`useInboxPoller.ts:982`). **Teammates in-process nao possuem nenhum mecanismo equivalente.**

Se um teammate in-process entrar em loop infinito, travar silenciosamente, ou ficar preso em uma operacao assincrona que nunca resolve, nao ha nenhum mecanismo para o lider detectar que o agente parou de responder. O estado `status: 'running'` permanecera indefinidamente no AppState.

### PROBLEMA 4: Sem Timeout para Resposta de Shutdown

**Severidade**: ALTA
**Arquivos afetados**: `src/utils/swarm/backends/PaneBackendExecutor.ts:252-290`, `src/utils/swarm/backends/InProcessBackend.ts:192-253`

O lider envia `shutdown_request` e aguarda passivamente por `shutdown_approved` ou `shutdown_rejected`. Nao ha nenhum timeout configurado. Se o modelo do teammate:
- Entrar em loop e nunca processar a mensagem
- Recusar o shutdown repetidamente
- Travar antes de responder

O lider fica bloqueado indefinidamente aguardando uma resposta que nunca vira.

### PROBLEMA 5: Sem Detecção de Deadlock em Dependências de Tarefas

**Severidade**: ALTA
**Arquivos afetados**: `src/utils/swarm/inProcessRunner.ts:611-621` (`findAvailableTask`)

A funcao `findAvailableTask()` verifica se todas as tarefas em `blockedBy` estao resolvidas antes de considerar uma tarefa disponivel. Porem, se houver uma dependencia circular (ex: Tarefa 1 bloqueada por Tarefa 2, que esta bloqueada por Tarefa 1), **nenhuma tarefa sera jamais executada** e os teammates ficarao ociosos indefinidamente.

Nao ha verificacao de ciclo (ordenacao topologica) ao criar ou atualizar dependencias.

### PROBLEMA 6: Race Condition na Aquisição de Tarefas

**Severidade**: MEDIA
**Arquivos afetados**: `src/utils/swarm/inProcessRunner.ts:640-673` (`tryClaimNextTask`)

Multiplos teammates podem escanear a lista de tarefas simultaneamente. Ambos veem a mesma tarefa como `pending` e sem dono. O primeiro a chamar `claimTask()` vence, mas o segundo ja pode ter iniciado o processamento da tarefa antes de descobrir que nao conseguiu fazer o claim. A janela entre `listTasks()` (linha 645) e `claimTask()` (linha 652) e uma race condition classica.

### PROBLEMA 7: Arquivos de Inbox Orfaos

**Severidade**: MEDIA
**Arquivos afetados**: `src/utils/swarm/teamHelpers.ts:693-735` (`cleanupTeamDirectories`)

Quando teammates sao encerrados abruptamente (SIGKILL, OOM, crash), os arquivos de inbox (`~/.claude/teams/{equipe}/inboxes/{agente}.json`) permanecem no disco. A funcao `cleanupTeamDirectories()` remove o diretorio da equipe e de tarefas, mas nao limpa explicitamente os inboxes. Em execucoes repetidas, arquivos de inbox acumulam.

### PROBLEMA 8: Escritas Interleaved no Mailbox Durante Shutdown

**Severidade**: MEDIA
**Arquivos afetados**: `src/utils/teammateMailbox.ts:140-216`, `src/utils/swarm/inProcessRunner.ts:1380-1397`

Se um pedido de shutdown chega enquanto uma notificacao de idle esta sendo escrita, ou enquanto mensagens peer-to-peer estao sendo enviadas, as escritas concorrentes no mesmo arquivo de mailbox podem resultar em interleaving. Embora o lockfile mitigue parcialmente, a janela entre adquirir o lock e escrever o arquivo ainda existe.

### PROBLEMA 9: Inconsistencia Entre Memoria e Arquivo (In-Process)

**Severidade**: MEDIA
**Arquivos afetados**: `src/utils/swarm/inProcessRunner.ts:721-755`, `src/utils/teammateMailbox.ts:90-114`

Teammates in-process verificam primeiro `pendingUserMessages` em memoria (AppState, linha 724) e depois o arquivo de mailbox (linha 779). Se esses dois estados ficarem dessincronizados -- por exemplo, uma mensagem foi escrita no arquivo mas ainda nao foi adicionada ao pending -- a ordem de processamento pode divergir da ordem de envio.

### PROBLEMA 10: Sem Numeros de Sequencia nas Mensagens

**Severidade**: BAIXA (para o estado atual), ALTA (para escalabilidade)
**Arquivos afetados**: `src/utils/teammateMailbox.ts:49-56` (`TeammateMessage`)

As mensagens nao possuem numeros de sequencia ou version vectors. A unica garantia de ordenacao e FIFO via append ao arquivo JSON. Sob escrita concorrente com locks, essa garantia se enfraquece significativamente.

### PROBLEMA 11: Shutdown Starvation Parcial

**Severidade**: MEDIA
**Arquivos afetados**: `src/utils/swarm/inProcessRunner.ts:776-820`

O mecanismo de polling prioriza shutdown requests sobre mensagens regulares (scan de mensagens nao lidas, linha 789-799). Porem, se o teammate estiver no meio de uma chamada de ferramenta (tool call) de longa duracao, o shutdown request so sera processado **apos** a ferramenta completar. Nao ha mecanismo de interrupcao preemptiva durante a execucao de ferramentas.

### PROBLEMA 12: Falta de Endpoint de Saude (Health) para Teammates

**Severidade**: MEDIA
**Arquivos afetados**: Todos os arquivos de backend

Nao existe um endpoint ou mecanismo para o lider consultar "o que o teammate X esta fazendo agora?" alem de verificar a lista de tarefas. O lider nao sabe se um teammate esta:
- Processando uma resposta do modelo
- Aguardando permissao de ferramenta
- Preso em um loop de retry
- Compilando/executando codigo

---

## 4. Analise de Causa Raiz dos Loops de Idle

Os teammates ficam presos em estado ocioso pelos seguintes motivos encadeados:

### Cadeia 1: Perda de Mensagem -> Idle Fantasma

```
Teammate termina trabalho -> Marca isIdle=true -> Envia idle_notification
                                                                    |
                                                    [Contencao no lock do arquivo]
                                                                    |
                                                      Mensagem e PERDIDA (4 retries)
                                                                    |
                                          Lider nunca recebe notificacao
                                                                    |
                            Lider continua considerando teammate como ATIVO
                                                                    |
                     Novas mensagens para o teammate sao enfileiradas
                     mas nunca entregues pois o lider acha que esta ativo
                                                                    |
                                           Teammate fica ocioso indefinidamente
```

**Causa raiz**: `writeToMailbox()` descarta mensagens silenciosamente apos 4 tentativas falhas (`teammateMailbox.ts:212-216`).

### Cadeia 2: Race Condition do Poll do Lider

```
Teammate envia idle_notification (tempo T)
Lider faz poll em T-100ms -> nao ve mensagem
Lider faz poll em T+900ms -> deveria ver, mas...
                                                        |
                                   [Outra mensagem chegou entre T e T+900ms]
                                                        |
                      Lider processa a outra mensagem como "teammate ativo"
                                                        |
                          Idle notification e processada depois, mas
                          o lider ja iniciou um novo turno para o teammate
                                                        |
                           Turno e rejeitado (query ja rodando) -> mensagem
                           volta para fila -> ciclo potencialmente repetido
```

**Causa raiz**: Intervalo de poll de 1000ms (`useInboxPoller.ts:108`) cria janela onde o estado pode mudar entre polls.

### Cadeia 3: Crash de Processo In-Process sem Detecção

```
Teammate in-process entra em loop infinito ou trava
                              |
         Nenhum heartbeat existe para in-process
                              |
        Estado no AppState permanece status='running'
                              |
         Lider nao tem mecanismo para detectar anomalia
                              |
         Teammate aparece como "ativo" para sempre
                              |
         Novas tarefas nao sao atribuidas (acha que esta ocupado)
```

**Causa raiz**: Ausencia total de watchdog para teammates in-process (`spawnInProcess.ts` nao registra nenhum mecanismo de monitoramento).

---

## 5. Analise de Dessincronizacao de Status

### 5.1 Fontes de Verdade Conflitantes

O sistema mantem **tres fontes de verdade** para o status de um teammate:

| Fonte | Local | Atualizada por | Latencia |
|-------|-------|----------------|----------|
| AppState (memoria) | `tasks[id].isIdle` | `updateTaskState()` (in-process) | Instantanea |
| Arquivo config.json | `~/.claude/teams/{eq}/config.json` | `setMemberActive()` | Varia (lock) |
| Arquivo de inbox | `~/.claude/teams/{eq}/inboxes/{ag}.json` | `writeToMailbox()` | Varia (lock) |

Quando essas fontes divergem, nao ha mecanismo de reconciliacao.

### 5.2 Cenarios de Dessincronizacao

**Cenario A: Lider acha que teammate esta ativo, mas esta ocioso**
- Ocorre quando `idle_notification` e perdida (Problema 1)
- AppState do lider nunca recebe a atualizacao
- Sintoma: lider nao envia novas tarefas, achando que o teammate esta ocupado

**Cenario B: Lider acha que teammate esta ocioso, mas esta ativo**
- Ocorre quando o hook Stop dispara prematuramente (process-based)
- Ou quando `isIdle` e marcado mas o agente continua processando (race)
- Sintoma: lider envia nova tarefa enquanto a anterior ainda esta em andamento

**Cenario C: Teammate marcado como removido do team file mas ainda existe no AppState**
- Ocorre em `killInProcessTeammate()` que remove do team file (linha 303 de `spawnInProcess.ts`) mas o estado da tarefa pode permanecer inconsistente se o loop do agente ainda estiver rodando

### 5.3 Gap de Visibilidade

O lider nao possui um painel de saude que mostre:
- Ultimo heartbeat recebido por teammate
- Tempo desde a ultima atividade
- Contagem de mensagens perdidas
- Estado atual do loop de execucao

---

## 6. Recomendacoes

Priorizadas por impacto e complexidade de implementacao.

### P1 -- Criticas (implementar imediatamente)

#### R1: Adicionar Timeout de Resposta ao Shutdown
- **Onde**: `PaneBackendExecutor.terminate()`, `InProcessBackend.terminate()`
- **Como**: Adicionar timeout configuravel (ex: 30s) com fallback para `kill()` forcado
- **Impacto**: Evita que o lider fique bloqueado indefinidamente

#### R2: Adicionar Watchdog/Heartbeat para Teammates In-Process
- **Onde**: `startInProcessTeammate()` em `inProcessRunner.ts`
- **Como**: Registrar `setInterval` que atualiza `lastSeenAt` no AppState; lider verifica periodicamente
- **Impacto**: Permite deteccao de teammates in-process travados ou em loop infinito

#### R3: Eliminar Perda Silenciosa de Mensagens
- **Onde**: `writeToMailbox()` em `teammateMailbox.ts:212-216`
- **Como**: Lançar erro ou retornar `boolean` indicando sucesso/falha; logar warning visivel; considerar fila de retry assincrona
- **Impacto**: Garante que o lider seja notificado de falhas de comunicacao

#### R4: Adicionar Detecção de Ciclos em Dependências de Tarefas
- **Onde**: `findAvailableTask()` em `inProcessRunner.ts:611-621`; `claimTask()` em `tasks.ts`
- **Como**: Validacao via ordenacao topologica ao adicionar `blockedBy`; alertar ao detectar ciclo
- **Impacto**: Previne deadlock permanente de tarefas

### P2 -- Importantes (proximo sprint)

#### R5: Adicionar `force_shutdown` como Tipo de Mensagem
- **Onde**: `teammateMailbox.ts`, ambos os backends
- **Como**: Novo tipo de mensagem que ignora a decisao do modelo e executa terminacao direta
- **Impacto**: Override de emergencia quando o modelo recusa shutdown ou alucina

#### R6: Adicionar Acknowledgment para Mensagens Nao-Shutdown
- **Onde**: `teammateMailbox.ts`, `useInboxPoller.ts`
- **Como**: Campo `ack: boolean` nas mensagens; reenvio automatico apos timeout sem ack
- **Impacto**: Garantia de entrega para mensagens criticas

#### R7: Adicionar Numeros de Sequencia as Mensagens
- **Onde**: `TeammateMessage` type em `teammateMailbox.ts:49-56`
- **Como**: Campo `sequenceNumber: number` incrementado por remetente; deteccao de mensagens perdidas
- **Impacto**: Ordenacao garantida e deteccao de perda

#### R8: Limpar Arquivos de Inbox Durante Deleção de Equipe
- **Onde**: `cleanupTeamDirectories()` em `teamHelpers.ts:693-735`
- **Como**: Remover diretorio `inboxes/` junto com team e tasks
- **Impacto**: Previne acumulo de arquivos orfaos

### P3 -- Melhorias (backlog)

#### R9: Unificar Fontes de Verdade de Status
- **Onde**: Todo o sistema de status
- **Como**: Usar AppState como fonte primaria; sincronizar arquivo de forma assincrona e eventual; reconciliar divergencias periodicamente
- **Impacto**: Elimina inconsistencias entre memoria e disco

#### R10: Adicionar Painel de Saude do Lider
- **Onde**: Componente UI do lider
- **Como**: Mostrar ultimo heartbeat, tempo desde ultima atividade, contagem de mensagens perdidas por teammate
- **Impacto**: Visibilidade operacional para debugging

#### R11: Preempção de Shutdown Durante Tool Calls
- **Onde**: `runInProcessTeammate()` em `inProcessRunner.ts`
- **Como**: Usar `AbortController` da iteracao atual para interromper tool calls em andamento quando shutdown e forcado
- **Impacto**: Reduz tempo de resposta ao shutdown de minutos para segundos

---

## 7. Arquivos Relevantes

| Arquivo | Descricao |
|---------|-----------|
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | Ferramenta de criacao de equipes; ponto de entrada do fluxo |
| `src/utils/swarm/teamHelpers.ts` | Leitura/escrita de `config.json`, gerenciamento de membros, limpeza de diretorios |
| `src/utils/swarm/spawnInProcess.ts` | Spawn e registro de teammates in-process; `killInProcessTeammate()` |
| `src/utils/swarm/inProcessRunner.ts` | Loop principal do teammate in-process; `runAgent()`, idle notification, `waitForNextPromptOrShutdown()`, `findAvailableTask()` |
| `src/utils/swarm/teammateInit.ts` | Hooks de inicializacao para teammates baseados em paineis; hook Stop e heartbeat |
| `src/utils/swarm/backends/PaneBackendExecutor.ts` | Executor para teammates tmux/iTerm2; spawn, sendMessage, terminate, kill |
| `src/utils/swarm/backends/InProcessBackend.ts` | Executor para teammates in-process; adapta ao interface `TeammateExecutor` |
| `src/utils/teammateMailbox.ts` | Sistema de mailbox baseado em arquivos; `writeToMailbox()`, tipos de mensagens (idle, heartbeat, shutdown, permission) |
| `src/utils/mailbox.ts` | Classe `Mailbox` em memoria (signal-based, usada internamente) |
| `src/context/mailbox.tsx` | Provider React para o `Mailbox` em memoria |
| `src/hooks/useInboxPoller.ts` | Hook React de poll do inbox pelo lider; roteamento de mensagens, deteccao de dead teammates |

---

## Apêndice: Timeouts Existentes no Sistema

| Operacao | Valor | Local |
|----------|-------|-------|
| Poll de mailbox (in-process) | 500ms | `inProcessRunner.ts:713` |
| Poll de inbox (lider React) | 1000ms | `useInboxPoller.ts:108` |
| Heartbeat (process-based) | 15000ms | `teammateInit.ts:103` |
| Timeout de heartbeat (lider) | 45000ms | `useInboxPoller.ts:112` |
| Check de dead teammate | 5000ms | `useInboxPoller.ts:113` |
| Lock de arquivo (mailbox) | 10 retries, 5-100ms backoff | `teammateMailbox.ts:36-42` |
| Retry de escrita (mailbox) | 4 tentativas, 200ms * tentativa | `teammateMailbox.ts:46-47` |
| Lock de config.json | 10 retries, 5-100ms backoff | `teamHelpers.ts:20-26` |
| Timeout do hook Stop | 10000ms | `teammateInit.ts:146` |
| Poll de permissao | 500ms | `inProcessRunner.ts:114` |
| **Shutdown response timeout** | **NAO EXISTE** | -- |
| **Watchdog in-process** | **NAO EXISTE** | -- |
