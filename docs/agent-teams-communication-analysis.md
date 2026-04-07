# Análise do Sistema de Comunicação — Agent Teams & Teammates

## Visão Geral da Arquitetura

O sistema de Agent Teams utiliza um modelo **Leader/Teammate** com comunicação baseada em **arquivos** (mailbox) e **polling**. Existem dois modos de execução:

1. **In-process teammates** — executam no mesmo processo, isolados via `AsyncLocalStorage`
2. **Process-based teammates** — executam em panes tmux separadas, comunicam-se via sistema de arquivos

### Mecanismos de Comunicação Identificados

| Mecanismo | Função | Latência |
|---|---|---|
| Mailbox file-based | Mensagens entre teammate → leader | Polling 1s |
| `useInboxPoller` | Hook React que lê inbox a cada 1s | 1s |
| `waitForNextPromptOrShutdown` | Loop de espera para in-process teammates | Variável |
| Team config (`config.json`) | Estado compartilhado da equipe | I/O síncrona |
| Team Memory | Memória persistente compartilhada | I/O assíncrona |
| File locking (`proper-lockfile`) | Proteção contra escrita concorrente | 5-100ms retry |

---

## Problemas Identificados

### 1. Perda de Mensagens por Concorrência de Arquivo (SEVERIDADE: ALTA)

**Arquivos envolvidos:** `src/utils/teammateMailbox.ts`

O sistema de mailbox usa `proper-lockfile` com 10 retries e timeout de 5-100ms. Quando múltiplos teammates escrevem simultaneamente no mesmo arquivo de inbox:

- Se todas as 10 tentativas de lock falharem, a escrita é **silenciosamente descartada** — a mensagem nunca chega ao leader
- Não há fila de retry ou mecanismo de fallback para mensagens perdidas
- Em equipes grandes (5+ teammates), a probabilidade de colisão de lock cresce exponencialmente

**Cenário de risco:** 3 teammates ficam idle simultaneamente → todos enviam `idle_notification` → locks colidem → algumas notificações se perdem → o leader nunca sabe que todos terminaram.

---

### 2. Latência de Polling de 1 Segundo (SEVERIDADE: MÉDIA)

**Arquivos envolvidos:** `src/hooks/useInboxPoller.ts`

O hook `useInboxPoller` faz polling a cada 1 segundo. Isso significa:

- Uma mensagem pode levar até 1s para ser processada
- Em sequências de request/response entre leader e teammate, cada troca adiciona ~1s de latência
- Para tarefas que requerem coordenação fina (ex: aprovação de plano), isso adiciona atraso perceptível

**Impacto:** N teammates × 1s de polling = latência acumulada significativa em workflows interativos.

---

### 3. Divergência de Caminhos de Comunicação (SEVERIDADE: MÉDIA)

**Arquivos envolvidos:** `src/utils/teammate.ts`, `src/utils/teammateContext.ts`, `src/hooks/useInboxPoller.ts`

In-process teammates **não usam** `useInboxPoller` — eles têm seu próprio mecanismo `waitForNextPromptOrShutdown`. Isso cria:

- Dois caminhos de comunicação diferentes com semânticas distintas
- Mensagens enviadas ao mailbox de um in-process teammate podem não ser processadas pelo loop esperado
- Dificuldade de debugging: o comportamento muda dependendo do modo de execução

---

### 4. Race Condition no Idle Notification (SEVERIDADE: ALTA)

**Arquivos envolvidos:** `src/utils/swarm/teammateInit.ts`, `src/hooks/useInboxPoller.ts`

O idle notification é enviado via Stop hook no startup do teammate. Problemas:

- Se o teammate crashar antes do Stop hook executar, o leader fica esperando indefinidamente
- Não há timeout no `waitForTeammatesToBecomeIdle` — se um teammate morre sem enviar idle, o leader pode travar
- A verificação de `hasWorkingInProcessTeammates` faz snapshot de estado que pode ficar desatualizado entre a verificação e a ação

---

### 5. Ausência de Heartbeat / Detecção de teammate Morto (SEVERIDADE: ALTA)

Não existe mecanismo de heartbeat ou health check entre leader e teammates:

- Se um processo tmux morre (kill, crash, disconnect), o leader não detecta
- O leader continua aguardando mensagens que nunca chegarão
- Não há TTL ou expiração para mensagens no mailbox — mensagens antigas acumulam

---

### 6. Contenção no `config.json` Compartilhado (SEVERIDADE: MÉDIA)

**Arquivos envolvidos:** `src/utils/swarm/teamHelpers.ts`

Operações como `setMemberActive`, `setMemberMode`, `removeTeammateFromTeamFile` todas leem-modificam-escrevem o mesmo `config.json`:

- Sem garantia de atomicidade entre leitura e escrita
- Se dois teammates atualizam seu status simultaneamente, uma atualização pode sobrescrever a outra
- Não há versionamento ou optimistic concurrency control

---

### 7. Team Memory — Condições de Corrida (SEVERIDADE: BAIXA-MÉDIA)

**Arquivos envolvidos:** `src/utils/teamMemoryOps.ts`, `src/services/teamMemorySync/teamMemSecretGuard.ts`

- Escritas concorrentes na team memory não têm mecanismo de lock equivalente ao mailbox
- O secret guard (`teamMemSecretGuard.ts`) previne vazamento de segredos, mas não protege contra corrupção de dados por escrita simultânea
- Não há resolução de conflitos — a última escrita vence silenciosamente

---

### 8. Acoplamento entre Mailbox e React (SEVERIDADE: BAIXA)

**Arquivos envolvidos:** `src/hooks/useInboxPoller.ts`

O processamento de mensagens está acoplado ao hook React `useInboxPoller`. Isso significa:

- Mensagens só são processadas quando o componente React está montado e renderizando
- Se a UI está suspensa ou em background, mensagens podem ficar sem processar
- O routing de tipos de mensagem (permission_request, shutdown_request, etc.) está espalhado no hook, dificultando extensão

---

### 9. Cleanup Incompleto de Sessão (SEVERIDADE: MÉDIA)

**Arquivos envolvidos:** `src/utils/swarm/teamHelpers.ts` (`cleanupSessionTeams`)

Quando uma sessão termina:

- Inboxes podem conter mensagens não lidas que nunca serão consumidas
- O `config.json` pode referenciar membros que já não existem
- Não há garbage collection de inboxes de sessões antigas

---

### 10. Falta de Confirmação de Entrega (SEVERIDADE: ALTA)

O sistema de mailbox é **fire-and-forget**:

- `writeToMailbox` escreve no arquivo mas não confirma se o destinatário leu a mensagem
- Não há ACK/NACK entre remetente e destinatário
- Mensagens marcadas como "read" não significam que foram processadas — apenas lidas do arquivo
- Se o processo do leader crashar após marcar como read mas antes de processar, a mensagem é perdida

---

## Recomendações Conceituais (Sem Código)

### Curto Prazo

1. **Adicionar timeout em `waitForTeammatesToBecomeIdle`** — evitar travamento infinito do leader quando um teammate morre sem notificar

2. **Implementar heartbeat simples** — cada teammate escreve um timestamp no inbox periodicamente; o leader detecta teammates mortos após N segundos sem heartbeat

3. **Adicionar confirmação de entrega** — o leitor do mailbox deve escrever um ACK que o remetente pode verificar

4. **Aumentar retries de lock ou adicionar fallback** — quando o lock falha após 10 tentativas, a mensagem deve ser enfileirada para retry posterior, não descartada

### Médio Prazo

5. **Unificar caminhos de comunicação** — in-process e process-based teammates devem usar o mesmo protocolo de mensagens, mesmo que o transporte interno seja otimizado

6. **Adicionar versionamento ao `config.json`** — usar optimistic concurrency (ex: campo `version` incrementado a cada write) para detectar escritas conflitantes

7. **Implementar garbage collection de inboxes** — limpar mensagens antigas e inboxes de sessões encerradas

8. **Reduzir polling interval ou usar file watcher** — substituir polling de 1s por `fs.watch` ou `chokidar` para notificação instantânea de novas mensagens

### Longo Prazo

9. **Avaliar transporte alternativo** — para equipes grandes, o sistema de arquivos como barramento de mensagens não escala bem. Considerar:
   - Unix domain sockets para comunicação local
   - WebSocket loopback para in-process
   - Manter file-based apenas como fallback/portabilidade

10. **Adicionar telemetria de comunicação** — métricas de latência de mensagem, taxa de perda, tamanho de fila para debugging e monitoramento

---

## Resumo de Severidades

| # | Problema | Severidade | Impacto |
|---|---|---|---|
| 1 | Perda de mensagens por lock contention | ALTA | Mensagens críticas perdidas |
| 4 | Race condition no idle notification | ALTA | Leader pode travar indefinidamente |
| 5 | Sem detecção de teammate morto | ALTA | Recursos órfãos, waits infinitos |
| 10 | Sem confirmação de entrega | ALTA | Mensagens processadas incorretamente |
| 2 | Latência de polling de 1s | MÉDIA | UX lenta em coordenação |
| 3 | Divergência de caminhos de comunicação | MÉDIA | Bugs difíceis de reproduzir |
| 6 | Contenção no config.json | MÉDIA | Estado inconsistente da equipe |
| 9 | Cleanup incompleto de sessão | MÉDIA | Acúmulo de lixo no filesystem |
| 7 | Race conditions na team memory | BAIXA-MÉDIA | Corrupção ocasional de memória |
| 8 | Acoplamento mailbox-React | BAIXA | Mensagens atrasadas em certos estados |

---

*Relatório gerado em 2026-04-07 — Análise do sistema de comunicação Agent Teams*
