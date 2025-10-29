# Sistema de Notificações de Estoque Baixo

## Resumo das Implementações

Este documento descreve as mudanças implementadas para substituir o sistema de alertas por email por um sistema de notificações locais que alerta quando produtos ficam com estoque baixo.

## Funcionalidades Implementadas

### 1. Notificações Locais em Tempo Real
- Notificações push locais quando produtos estão com estoque abaixo do mínimo
- Notificações programadas para se repetirem a cada 4 horas enquanto houver produtos com estoque baixo
- Cancelamento automático das notificações quando não há mais produtos com estoque baixo

### 2. Gerenciamento Automático
- O sistema verifica automaticamente o estoque em:
  - Inicialização do app
  - Adição de novos produtos
  - Edição de produtos existentes
  - Exclusão de produtos
- Agendamento/cancelamento inteligente baseado na situação atual do estoque

## Arquivos Criados

### 1. `NotificationHelper.java`
Classe responsável por gerenciar as notificações locais:
- Criação do canal de notificação (Android 8.0+)
- Exibição de notificações com informações dos produtos
- Cancelamento de notificações
- Verificação de permissões (Android 13+)

### 2. `LowStockWorker.java`
Worker do WorkManager que executa periodicamente:
- Verifica produtos com estoque baixo a cada 4 horas
- Busca dados diretamente do banco de dados SQLite
- Envia notificações com até 3 produtos na mensagem
- Tratamento de erros robusto

### 3. `LowStockScheduler.java`
Classe utilitária para gerenciar o agendamento:
- Agenda notificações periódicas quando há produtos com estoque baixo
- Cancela notificações quando não há mais produtos com estoque baixo
- Verifica automaticamente a situação do estoque

## Arquivos Modificados

### 1. `build.gradle` (app)
Adicionadas dependências:
```gradle
implementation 'androidx.work:work-runtime:2.10.0'
implementation 'com.google.guava:guava:31.1-android'
```

### 2. `AndroidManifest.xml`
Adicionadas permissões:
```xml
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

### 3. `MainActivity.java`
- Adicionada chamada para `LowStockScheduler.checkAndScheduleNotifications()` no `onCreate()`
- Adicionada chamada no método `deleteProduct()` após exclusão

### 4. `AddActivity.java`
- Adicionada chamada para `LowStockScheduler.checkAndScheduleNotifications()` após adicionar produto

### 5. `EditActivity.java`
- Adicionada chamada para `LowStockScheduler.checkAndScheduleNotifications()` após editar produto

### 6. `ReportsActivity.java`
- **REMOVIDOS** métodos relacionados a alertas por email:
  - `showEmailReportFeature()`
  - `sendReportByEmail()`
  - `showLowStockAlertsFeature()`
  - `checkLowStockAndNotify()`
  - `showPremiumRequiredDialog()`
- Removidas opções de menu de email e alertas

## Como Funciona

### Fluxo de Funcionamento

1. **Inicialização do App**
   - Ao abrir o app, o sistema verifica se há produtos com estoque baixo
   - Se houver, agenda notificações periódicas a cada 4 horas
   - Se não houver, cancela qualquer agendamento anterior

2. **Adição/Edição/Exclusão de Produtos**
   - Após qualquer alteração no estoque, o sistema verifica novamente
   - Atualiza o agendamento conforme necessário

3. **Notificações Periódicas**
   - A cada 4 horas, o `LowStockWorker` é executado
   - Verifica produtos com `amount <= min_stock`
   - Envia notificação com lista dos produtos (máximo 3 na mensagem)

4. **Cancelamento Automático**
   - Quando todos os produtos voltam a ter estoque adequado, as notificações são canceladas automaticamente

## Critérios para Estoque Baixo

Um produto é considerado com estoque baixo quando:
- O campo `min_stock` é maior que 0
- O campo `amount` é menor ou igual a `min_stock`

Exemplo:
- Produto com `amount = 5` e `min_stock = 10` → **Estoque Baixo**
- Produto com `amount = 15` e `min_stock = 10` → **Estoque Normal**
- Produto com `amount = 0` e `min_stock = 0` → **Não Monitora** (min_stock não definido)

## Permissões Necessárias

### Android 13+ (API 33+)
- `POST_NOTIFICATIONS`: Já estava presente no manifest, necessária para enviar notificações

### Todas as Versões
- `SCHEDULE_EXACT_ALARM`: Para agendar notificações periódicas precisas
- `RECEIVE_BOOT_COMPLETED`: Para reagendar notificações após reinicialização do dispositivo

## Tecnologias Utilizadas

- **WorkManager**: Framework do Android para trabalhos em background
- **NotificationManager**: API nativa do Android para notificações
- **SQLite**: Banco de dados local do app
- **SharedPreferences**: Não utilizado (removido do código anterior)

## Vantagens da Nova Implementação

1. **Sem Dependência de Email**: Funciona completamente offline
2. **Notificações Imediatas**: Usuário é alertado em tempo real
3. **Gerenciamento Automático**: Sistema inteligente que agenda/cancela conforme necessário
4. **Eficiência Energética**: WorkManager otimiza o uso de bateria
5. **Confiabilidade**: Notificações persistem mesmo após reinicialização do dispositivo
6. **Sem Necessidade de Premium**: Funcionalidade disponível para todos os usuários

## Observações Importantes

- As notificações respeitam as configurações de "Não Perturbe" do Android
- O usuário pode desativar notificações nas configurações do sistema
- Em Android 13+, o app solicitará permissão de notificação ao usuário
- O WorkManager garante que as notificações sejam enviadas mesmo com o app fechado

## Testando a Implementação

Para testar o sistema:

1. **Adicionar um produto com estoque baixo**:
   - Adicione um produto com `amount = 5` e `min_stock = 10`
   - Uma notificação será agendada

2. **Aguardar ou Simular**:
   - A primeira notificação pode demorar até 4 horas
   - Você pode testar forçando a execução do Worker no Android Studio

3. **Normalizar o estoque**:
   - Edite o produto para `amount = 15`
   - As notificações serão canceladas automaticamente

4. **Excluir produtos**:
   - Exclua o produto com estoque baixo
   - As notificações serão canceladas se não houver mais produtos com estoque baixo

## Manutenção Futura

Para ajustar o intervalo de notificações, modifique a constante em `LowStockScheduler.java`:

```java
private static final long REPEAT_INTERVAL_HOURS = 4; // Alterar para o valor desejado
```

---

**Data de Implementação**: 29 de Outubro de 2025
**Versão**: 11.0

