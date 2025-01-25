import React from 'react';
import {
  Button,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
} from 'react-native';
import {styles} from './styles';
import {useLlmInference} from 'react-native-llm-mediapipe';

const prompt = `<start_of_turn>user
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
INR 2,566.60 spent on ICICI Bank Card XX2002 on 15-Oct-23 at Agoda Company P. Avl Lmt: INR 28,141.50. To dispute,call 18002662/SMS BLOCK 2002 to 9215676766<end_of_turn>
<start_of_turn>model`;

function App(): React.JSX.Element {
  const llmInference = useLlmInference({
    storageType: 'asset',
    modelName: 'gemma-1.1-2b-it-cpu-int4.bin',
    maxTokens: 1024,
    // 'gemma-1.1-2b-it-gpu-int4.bin' or the name of the model that
    // you placed at android/app/src/main/assets/{MODEL_FILE}
  });

  const onSendPrompt = React.useCallback(async () => {
    const response = await llmInference.generateResponse(
      prompt,
      partial => {
        console.log('====================================');
        console.log(partial);
        console.log('====================================');
      },
      error => {
        console.error(error);
      },
    );
    console.log('====================================');
    console.log(response);
    console.log('====================================');
  }, [llmInference]);

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        keyboardVerticalOffset={0}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardRoot}>
        <Button title="SUBMIT" onPress={onSendPrompt} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default App;
