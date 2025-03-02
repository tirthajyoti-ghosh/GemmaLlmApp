import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  Modal,
  ScrollView,
} from 'react-native';
import {PermissionsAndroid} from 'react-native';
import SmsAndroid from 'react-native-get-sms-android';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundService from 'react-native-background-actions';
import {useLlmInference} from 'react-native-llm-mediapipe';
import Icon from 'react-native-vector-icons/MaterialIcons';

const STORAGE_KEY = '@expense_transactions';
const LAST_PROCESSED_TIME_KEY = '@last_processed_time';
const TRANSACTION_PARSER_PROMPT = `<start_of_turn>user
You are a transaction parser. For the given SMS message, extract the following information by following these steps:

1. For Amount: Find numbers after Rs, INR, or spent/debited/credited
2. For Type: Look for words like 'spent', 'debited' (-> debit) or 'credited', 'refund' (-> credit)
3. For Payment Method: Look for 'Credit Card', 'UPI', 'Debit Card', etc.
4. For Merchant: 
   - Look for text after 'at', 'to', or 'from'
   - Remove any reference numbers or extra information
   - Don't include the bank name (ICICI, SBI) as merchant
5. For Date: Convert any date format to DD-MM-YY

Examples:
SMS: "INR 2,566.60 spent on ICICI Bank Card XX2002 on 15-Oct-23 at Agoda Company P. Avl Lmt: INR 28,141.50"
Output: {"amount":"2566.60","type":"debit","payment_method":"Credit Card","merchant":"Agoda Company","date":"15-10-23"}

SMS: "Dear UPI user A/C X3508 debited by 400.0 on date 08Nov23 trf to MARTHA SWER"
Output: {"amount":"400","type":"debit","payment_method":"UPI","merchant":"MARTHA SWER","date":"08-11-23"}

SMS: "Rs.719.00 spent on your SBI Credit Card ending 0535 at DREAMPLUG TECHNOLOGI on 14/11/23"
Output: {"amount":"719","type":"debit","payment_method":"Credit Card","merchant":"DREAMPLUG TECHNOLOGI","date":"14-11-23"}

SMS: "Dear Customer, refund of INR 367 from Axis has been credited to your ICICI Bank Credit Card XX6003 on 13-NOV-23"
Output: {"amount":"367","type":"credit","payment_method":"Credit Card","merchant":"Axis","date":"13-11-23"}

Now parse this SMS:
{MESSAGE}<end_of_turn>
<start_of_turn>model`;

// Helper functions for AsyncStorage
const storage = {
  async getTransactions() {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Failed to load transactions:', e);
      return [];
    }
  },

  async appendTransactions(newTransactions: any[]) {
    try {
      const existing = await this.getTransactions();
      const updated = [...existing, ...newTransactions];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      console.error('Failed to save transactions:', e);
      return [];
    }
  },

  async getLastProcessedTime() {
    try {
      const time = await AsyncStorage.getItem(LAST_PROCESSED_TIME_KEY);
      return time ? parseInt(time) : 0;
    } catch (e) {
      return 0;
    }
  },

  async setLastProcessedTime(time: number) {
    await AsyncStorage.setItem(LAST_PROCESSED_TIME_KEY, time.toString());
  },

  async clearAllTransactions() {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
      await AsyncStorage.removeItem(LAST_PROCESSED_TIME_KEY);
      return true;
    } catch (e) {
      console.error('Failed to clear transactions:', e);
      return false;
    }
  },
};

const App = () => {
  const [transactions, setTransactions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [granted, setGranted] = useState(false);
  const [filterType, setFilterType] = useState('all'); // 'all', 'debit', 'credit'
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [summary, setSummary] = useState({total: 0, debit: 0, credit: 0});
  const [modalVisible, setModalVisible] = useState(false);

  const llmInference = useLlmInference({
    storageType: 'asset',
    modelName: 'gemma-1.1-2b-it-cpu-int4.bin',
    maxTokens: 1024,
  });

  const parseMessage = useCallback(
    async (message: string) => {
      try {
        const prompt = TRANSACTION_PARSER_PROMPT.replace('{MESSAGE}', message);
        const response = await llmInference.generateResponse(
          prompt,
          partial => {
            console.log('Partial response:', partial);
          },
          error => {
            console.error('LLM Error:', error);
          },
        );

        try {
          // Parse the LLM response as JSON
          return JSON.parse(response.trim());
        } catch (e) {
          console.error('Failed to parse LLM response as JSON:', e);
          return null;
        }
      } catch (e) {
        console.error('Error processing message with LLM:', e);
        return null;
      }
    },
    [llmInference],
  );

  const SMS_PROCESSOR = useCallback(
    {
      async processNewMessages() {
        const lastProcessedTime = await storage.getLastProcessedTime();
        const currentTime = Date.now();

        const filter = {
          minDate: lastProcessedTime,
          maxDate: currentTime,
        };

        return new Promise((resolve, reject) => {
          SmsAndroid.list(
            JSON.stringify(filter),
            (            error: any) => reject(error),
            async (count: number, smsListStr: string) => {
              if (count === 0) {
                resolve([]);
                return;
              }

              const messages = JSON.parse(smsListStr);
              const results = await this.processMessages(messages);

              if (results.length > 0) {
                const updated = await storage.appendTransactions(results);
                setTransactions(updated);
                calculateSummary(updated);
              }
              await storage.setLastProcessedTime(currentTime);

            resolve(results);
            },
          );
        });
      },

      async processMessages(messages: any[]) {
        const results = [];
        // Process in smaller chunks to avoid memory issues
        const CHUNK_SIZE = 5;

        for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
          const chunk = messages.slice(i, i + CHUNK_SIZE);
          const chunkResults = await this.processChunk(chunk);
          results.push(...chunkResults);
        }

        return results;
      },

      async processChunk(messages: any[]) {
        const results = [];
        for (const message of messages) {
          if (message.body.match(/(?:INR|Rs\.?|spent|debited|credited)/i)) {
            const parsed = await parseMessage(message.body);
            if (parsed) {
              results.push({
                ...parsed,
                id: `${message.date}_${Math.random()
                  .toString(36)
                  .substr(2, 9)}`,
                originalMessage: message.body,
                timestamp: message.date,
              });
            }
          }
        }
        return results;
      },
    },
    [parseMessage],
  );

  // Background task options
  const backgroundOptions = {
    taskName: 'SMSMonitor',
    taskTitle: 'SMS Expense Monitoring',
    taskDesc: 'Monitoring new SMS for expenses',
    taskIcon: {
      name: 'ic_launcher',
      type: 'mipmap',
    },
    color: '#ff00ff',
    parameters: {
      delay: 60000, // Check every minute
    },
  };

  // Background task function
  const backgroundTask = useCallback(
    async (taskDataArguments: { delay: number | undefined; }) => {
      await new Promise(async resolve => {
        const loop = async () => {
          try {
            await SMS_PROCESSOR.processNewMessages();
          } catch (e) {
            console.error('Background processing error:', e);
          }
          await new Promise(r => setTimeout(r, taskDataArguments.delay));
          loop();
        };
        loop();
      });
    },
    [SMS_PROCESSOR],
  );

  // Calculate summary statistics
  const calculateSummary = useCallback((txns: any[]) => {
    const summary = {
      total: 0,
      debit: 0,
      credit: 0,
    };

    txns.forEach((tx: { amount: string; type: string; }) => {
      const amount = parseFloat(tx.amount);
      if (!isNaN(amount)) {
        if (tx.type === 'debit') {
          summary.debit += amount;
        } else if (tx.type === 'credit') {
          summary.credit += amount;
        }
      }
    });

    summary.total = summary.credit - summary.debit;
    setSummary(summary);
  }, []);

  // Request SMS permissions
  const requestSMSPermission = useCallback(async () => {
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_SMS,
        {
          title: 'SMS Permission',
          message: 'This app needs access to your SMS messages.',
          buttonNeutral: 'Ask Me Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'OK',
        },
      );
      setGranted(result === PermissionsAndroid.RESULTS.GRANTED);
    } catch (err) {
      console.error('Permission request failed:', err);
      setGranted(false);
    }
  }, []);

  // Initial load of historical messages
  const loadHistoricalMessages = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter = {
        indexFrom: 0,
        maxDate: Date.now(),
      };

      return new Promise((resolve, reject) => {
        SmsAndroid.list(
          JSON.stringify(filter),
          reject,
          async (count: any, smsListStr: string) => {
            const messages = JSON.parse(smsListStr);
            const results = await SMS_PROCESSOR.processMessages(messages);
            const updated = await storage.appendTransactions(results);
            setTransactions(updated);
            calculateSummary(updated);
            resolve(results);
          },
        );
      });
    } finally {
      setIsLoading(false);
    }
  }, [SMS_PROCESSOR, calculateSummary]);

  // Start background monitoring
  const startBackgroundMonitoring = useCallback(async () => {
    try {
      await BackgroundService.start(backgroundTask, backgroundOptions);
    } catch (e) {
      console.error('Failed to start background service:', e);
    }
  }, [backgroundTask, backgroundOptions]);

  useEffect(() => {
    requestSMSPermission();
  }, [requestSMSPermission]);

  useEffect(() => {
    if (!granted) {return;}

    const initialize = async () => {
      // Load existing transactions
      const savedTransactions = await storage.getTransactions();
      setTransactions(savedTransactions);
      calculateSummary(savedTransactions);

      // If no transactions exist, load historical messages
      if (savedTransactions.length === 0) {
        await loadHistoricalMessages();
      }

      setIsLoading(false);

      // Start background monitoring
      await startBackgroundMonitoring();
    };

    initialize();

    // Cleanup
    return () => {
      BackgroundService.stop();
    };
  }, [
    granted,
    loadHistoricalMessages,
    startBackgroundMonitoring,
    calculateSummary,
  ]);

  // Refresh transactions from storage
  const refreshTransactions = useCallback(async () => {
    setRefreshing(true);
    try {
      await SMS_PROCESSOR.processNewMessages();
      const updated = await storage.getTransactions();
      setTransactions(updated);
      calculateSummary(updated);
    } catch (e) {
      console.error('Error refreshing transactions:', e);
    } finally {
      setRefreshing(false);
    }
  }, [SMS_PROCESSOR, calculateSummary]);

  // Clear all data
  const clearAllData = useCallback(async () => {
    const success = await storage.clearAllTransactions();
    if (success) {
      setTransactions([]);
      setSummary({total: 0, debit: 0, credit: 0});
    }
  }, []);

  const filteredTransactions = useCallback(() => {
    if (filterType === 'all') {return transactions;}
    return transactions.filter(tx => tx.type === filterType);
  }, [transactions, filterType]);

  const renderTransactionItem = useCallback(({item}) => {
    const date = new Date(parseInt(item.timestamp));
    const formattedDate = `${date.getDate()}/${
      date.getMonth() + 1
    }/${date.getFullYear()}`;

    return (
      <TouchableOpacity
        style={styles.transactionItem}
        onPress={() => {
          setSelectedTransaction(item);
          setModalVisible(true);
        }}>
        <View style={styles.transactionHeader}>
          <Text style={styles.merchantName}>
            {item.merchant || 'Unknown Merchant'}
          </Text>
          <Text
            style={[
              styles.amount,
              item.type === 'debit' ? styles.debitAmount : styles.creditAmount,
            ]}>
            {item.type === 'debit' ? '-' : '+'}₹{item.amount}
          </Text>
        </View>

        <View style={styles.transactionDetails}>
          <Text style={styles.paymentMethod}>
            {item.payment_method || 'Unknown Method'}
          </Text>
          <Text style={styles.date}>{item.date || formattedDate}</Text>
        </View>
      </TouchableOpacity>
    );
  }, []);

  if (!granted) {
    return (
      <SafeAreaView style={styles.permissionContainer}>
        <Text style={styles.permissionTitle}>SMS Permission Required</Text>
        <Text style={styles.permissionText}>
          This app needs access to your SMS messages to track expenses
          automatically.
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={requestSMSPermission}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar backgroundColor="#4A148C" barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>SMS Expense Tracker</Text>
        <TouchableOpacity
          style={styles.clearButton}
          onPress={clearAllData}
        >
          <Icon name="delete" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Summary Card */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryTitle}>Total Balance</Text>
          <Text
            style={[
              styles.summaryAmount,
              summary.total >= 0
                ? styles.positiveAmount
                : styles.negativeAmount,
            ]}>
            ₹{Math.abs(summary.total).toFixed(2)}
          </Text>
        </View>

        <View style={styles.summaryDetails}>
          <View style={styles.summaryDetailItem}>
            <Icon name="arrow-downward" size={20} color="#4CAF50" />
            <View style={styles.detailTextContainer}>
              <Text style={styles.detailLabel}>Income</Text>
              <Text style={styles.detailAmount}>
                ₹{summary.credit.toFixed(2)}
              </Text>
            </View>
          </View>

          <View style={styles.summaryDetailItem}>
            <Icon name="arrow-upward" size={20} color="#F44336" />
            <View style={styles.detailTextContainer}>
              <Text style={styles.detailLabel}>Expenses</Text>
              <Text style={styles.detailAmount}>
                ₹{summary.debit.toFixed(2)}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Filter Tabs */}
      <View style={styles.filterTabs}>
        <TouchableOpacity
          style={[
            styles.filterTab,
            filterType === 'all' && styles.activeFilterTab,
          ]}
          onPress={() => setFilterType('all')}>
          <Text
            style={[
              styles.filterTabText,
              filterType === 'all' && styles.activeFilterText,
            ]}>
            All
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterTab,
            filterType === 'debit' && styles.activeFilterTab,
          ]}
          onPress={() => setFilterType('debit')}>
          <Text
            style={[
              styles.filterTabText,
              filterType === 'debit' && styles.activeFilterText,
            ]}>
            Expenses
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterTab,
            filterType === 'credit' && styles.activeFilterTab,
          ]}
          onPress={() => setFilterType('credit')}>
          <Text
            style={[
              styles.filterTabText,
              filterType === 'credit' && styles.activeFilterText,
            ]}>
            Income
          </Text>
        </TouchableOpacity>
      </View>

      {/* Transaction List */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4A148C" />
          <Text style={styles.loadingText}>Processing SMS Messages...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredTransactions()}
          renderItem={renderTransactionItem}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.transactionList}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refreshTransactions}
              colors={['#4A148C']}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Icon name="inbox" size={64} color="#BDBDBD" />
              <Text style={styles.emptyText}>No transactions found</Text>
              <TouchableOpacity
                style={styles.refreshButton}
                onPress={refreshTransactions}>
                <Text style={styles.refreshButtonText}>Scan SMS Messages</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}

      {/* Transaction Details Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Transaction Details</Text>
              <TouchableOpacity
                onPress={() => setModalVisible(false)}
                style={styles.closeButton}>
                <Icon name="close" size={24} color="#4A148C" />
              </TouchableOpacity>
            </View>

            {selectedTransaction && (
              <ScrollView style={styles.modalBody}>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Merchant</Text>
                  <Text style={styles.detailValue}>
                    {selectedTransaction.merchant || 'Unknown'}
                  </Text>
                </View>

                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Amount</Text>
                  <Text
                    style={[
                      styles.detailValue,
                      selectedTransaction.type === 'debit'
                        ? styles.debitDetailAmount
                        : styles.creditDetailAmount,
                    ]}>
                    {selectedTransaction.type === 'debit' ? '-' : '+'}₹
                    {selectedTransaction.amount}
                  </Text>
                </View>

                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Date</Text>
                  <Text style={styles.detailValue}>
                    {selectedTransaction.date}
                  </Text>

                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Payment Method</Text>
                  <Text style={styles.detailValue}>
                    {selectedTransaction.payment_method || 'Unknown'}
                  </Text>
                </View>

                <View style={styles.messageContainer}>
                  <Text style={styles.messageLabel}>Original Message</Text>
                  <Text style={styles.messageText}>
                    {selectedTransaction.originalMessage}
                  </Text>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  header: {
    backgroundColor: '#4A148C',
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
  },
  clearButton: {
    padding: 8,
  },
  summaryCard: {
    backgroundColor: '#FFFFFF',
    margin: 16,
    borderRadius: 12,
    padding: 16,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  summaryTitle: {
    fontSize: 16,
    color: '#757575',
  },
  summaryAmount: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  positiveAmount: {
    color: '#4CAF50',
  },
  negativeAmount: {
    color: '#F44336',
  },
  summaryDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryDetailItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailTextContainer: {
    marginLeft: 8,
  },
  detailLabel: {
    fontSize: 12,
    color: '#757575',
  },
  detailAmount: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#424242',
  },
  filterTabs: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeFilterTab: {
    backgroundColor: '#4A148C',
  },
  filterTabText: {
    fontWeight: 'bold',
    color: '#757575',
  },
  activeFilterText: {
    color: '#FFFFFF',
  },
  transactionList: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  transactionItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  transactionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  merchantName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#212121',
    flex: 1,
  },
  amount: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  debitAmount: {
    color: '#F44336',
  },
  creditAmount: {
    color: '#4CAF50',
  },
  transactionDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  paymentMethod: {
    fontSize: 14,
    color: '#757575',
  },
  date: {
    fontSize: 14,
    color: '#757575',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    color: '#616161',
    fontSize: 16,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    color: '#757575',
    fontSize: 16,
    marginTop: 16,
    marginBottom: 24,
  },
  refreshButton: {
    backgroundColor: '#4A148C',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  refreshButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingBottom: 24,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#212121',
  },
  closeButton: {
    padding: 4,
  },
  modalBody: {
    marginTop: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  detailValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#212121',
  },
  debitDetailAmount: {
    color: '#F44336',
  },
  creditDetailAmount: {
    color: '#4CAF50',
  },
  messageContainer: {
    marginTop: 16,
  },
  messageLabel: {
    fontSize: 14,
    color: '#757575',
    marginBottom: 8,
  },
  messageText: {
    fontSize: 14,
    color: '#424242',
    lineHeight: 20,
    backgroundColor: '#F5F5F5',
    padding: 12,
    borderRadius: 8,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#4A148C',
    marginBottom: 16,
  },
  permissionText: {
    fontSize: 16,
    color: '#616161',
    textAlign: 'center',
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: '#4A148C',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  permissionButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
});

export default App;
