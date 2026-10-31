# iPOSpays sandbox test cards

From the iPOSpays/TSYS UAT sheet ("UAT trigger amounts"). Sandbox only: these cards don't
work in production. They expire 12/26, so ask devsupport@denovosystem.com for a newer sheet
after that.

## Quick picks for FarriTech testing

| Test | Card | Amount charged |
|---|---|---|
| Approved payment | Visa 4012 0000 9876 5439, 12/26, CVV 999, address 8320, zip 85284 | $10.00 or $0.50 |
| Void (same day), refund (after settlement) | same Visa | pay $10.00 first |
| Partial refund | same Visa | pay $10.00, refund e.g. $4.00 |
| Decline (do not honor) | same Visa | $0.20 |
| Insufficient funds | same Visa | $0.21 |
| CVV mismatch | same Visa | $0.48 |
| Expired card | same Visa | $0.29 |

The trigger is the **amount iPOSpays charges**, not the invoice's cash price. A pay link
charges the card price unless it's waived, so waive the card price on the invoice (or set the
invoice so its card price is the trigger amount) before sending the link.

A declined page can't be used again: opening the pay link after a decline makes a new page.

---

## Test Card Numbers:

| CARD BRAND | CARD NUMBER         | EXP DATE | CVV  | Address | Zip Code |
|------------|---------------------|----------|------|---------|----------|
| VISA       | 4012 0000 9876 5439 | 12/26    | 999  | 8320    | 85284    |
| MasterCard | 5146 3150 0000 0055 | 12/26    | 998  | 8320    | 85284    |
| Amex       | 3714 4963 5392 376  | 12/26    | 9997 | 8320    | 85284    |
| Discover   | 6011 0009 9302 6909 | 12/26    | 996  | 8320    | 85284    |

## Visa: Transaction Response Codes & Trigger Amounts:

| Transaction Trigger Amount | Response Code | Response Text                              | Notes                                                                                                                                                                        |
|----------------------------|---------------|--------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0                          | 85            | Card OK                                    |                                                                                                                                                                              |
| 0.01                       | 01            | Call Issuer                                |                                                                                                                                                                              |
| 0.02                       | 02            | Call Issuer, Special Condition             |                                                                                                                                                                              |
| 0.03                       | 28            | File Temp. Unavailable                     |                                                                                                                                                                              |
| 0.04                       | 91            | Issuer Unavailable or Inoperative, No STIP |                                                                                                                                                                              |
| 0.05                       | 04            | Pick Up Card                               |                                                                                                                                                                              |
| 0.06                       | 07            | Pick Up Card, Special Cond.                |                                                                                                                                                                              |
| 0.07                       | 41            | Pick Up Card Lost                          |                                                                                                                                                                              |
| 0.08                       | 43            | Pick Up Card, Stolen                       |                                                                                                                                                                              |
| 0.09                       | 06            | General Error                              |                                                                                                                                                                              |
| 0.10                       | 79            | Already Reversed                           |                                                                                                                                                                              |
| 0.11                       | 13            | Invalid Amount                             |                                                                                                                                                                              |
| 0.12                       | 83            | Can’t Verify PIN                           |                                                                                                                                                                              |
| 0.13                       | 86            | Can’t Verify PIN                           |                                                                                                                                                                              |
| 0.14                       | 14            | Invalid Account Number                     |                                                                                                                                                                              |
| 0.15                       | 82            | Incorrect CVV                              | CVV Data is not correct OR Offline PIN authentication interrupted                                                                                                            |
| 0.16                       | N3            | Cashback Not Available                     |                                                                                                                                                                              |
| 0.17                       | 06            | General Error                              |                                                                                                                                                                              |
| 0.18                       | EC            | CID Format Error                           |                                                                                                                                                                              |
| 0.19                       | 80            | No Financial Impact                        |                                                                                                                                                                              |
| 0.20                       | 05            | Decline                                    |                                                                                                                                                                              |
| 0.21                       | 51            | Decline                                    |                                                                                                                                                                              |
| 0.22                       | N4            | Decline                                    |                                                                                                                                                                              |
| 0.23                       | 61            | EXC APPR AMT LM                            | Exceeds approval amount limit                                                                                                                                                |
| 0.24                       | 62            | Decline                                    |                                                                                                                                                                              |
| 0.25                       | 65            | EXC W/D FREQ LIM                           |                                                                                                                                                                              |
| 0.26                       | 93            | Decline                                    |                                                                                                                                                                              |
| 0.28                       | 06            | General Error                              |                                                                                                                                                                              |
| 0.29                       | 54            | Expired Card                               | Be sure to default IIID/RIID values to 0000 to provoke Direct Check Service Error Response. A Production IIID/RIID will provoke a response of Error 06 “Check Response Text” |
| 0.40                       | 75            | PIN Exceeded                               |                                                                                                                                                                              |
| 0.41                       | 19            | Re-enter                                   |                                                                                                                                                                              |
| 0.42                       | 63            | SEC Violation                              |                                                                                                                                                                              |
| 0.43                       | 57            | Txn Not Permitted                          |                                                                                                                                                                              |
| 0.44                       | 58            | Serv Not Allowed                           |                                                                                                                                                                              |
| 0.45                       | 96            | System Error                               |                                                                                                                                                                              |
| 0.46                       | 03            | Term ID Error                              |                                                                                                                                                                              |
| 0.47                       | 55            | Wrong PIN                                  |                                                                                                                                                                              |
| 0.48                       | N7            | CVV Mismatch                               |                                                                                                                                                                              |
| 0.49                       | 85            | Card OK                                    |                                                                                                                                                                              |
| 0.50                       | 00            | Approval                                   |                                                                                                                                                                              |
| 0.54                       | 94            | Duplicate Transaction                      | Accepted MTI 0100 or 0200 only                                                                                                                                               |
| 0.96                       | R0            | Stop Recurring                             |                                                                                                                                                                              |
| 0.97                       | R1            | Revoke Auth Order                          |                                                                                                                                                                              |
| 1.12                       | 05            | Decline                                    |                                                                                                                                                                              |
| 1.13                       | 05            | Decline                                    |                                                                                                                                                                              |
| 1.30                       | 00            | Approval                                   | No ACI Field Returned                                                                                                                                                        |
| 1.31                       | 00            | Approval                                   | Blank Space Returned for the ACI                                                                                                                                             |
| 1.34                       | 30            | Msg Format Error                           |                                                                                                                                                                              |
| 10.00                      | 00            | Approval                                   |                                                                                                                                                                              |
| 32.48                      | 00            | Approval                                   | No Auth Code                                                                                                                                                                 |
| 32.88                      | 25            | No Card Number                             |                                                                                                                                                                              |
| 32.85                      | 11            | Approval                                   |                                                                                                                                                                              |
| 33.17                      | Z6            | FIX INVALID MCC                            |                                                                                                                                                                              |
| 64.01                      | 89            | Ineligible GIV                             |                                                                                                                                                                              |
| 64.02                      | H6            | Fail Get BDK                               |                                                                                                                                                                              |
| 64.03                      | H7            | Fail Get KPEI                              |                                                                                                                                                                              |
| 64.04                      | H8            | Encryption Error                           |                                                                                                                                                                              |
| 64.05                      | H9            | System Error                               |                                                                                                                                                                              |
| 64.06                      | N6            | N6 Error                                   | Defunt, Will Remove FEB18                                                                                                                                                    |
| 64.10                      | 59            | Closed Account                             | All MTIs except 0130                                                                                                                                                         |
| 64.11                      | 59            | Suspected Fraud                            | All MTIs except 0130                                                                                                                                                         |
| 64.12                      | 6P            | Verification Data Failed                   | All MTIs except 0130                                                                                                                                                         |

## MasterCard: Transaction Response Codes & Trigger Amounts:

| Transaction Trigger Amount | Response Code | Response Text       | Notes |
|----------------------------|---------------|---------------------|-------|
| 0.01                       | 01            | Call Issuer         |       |
| 0.05                       | 04            | Capture Card        |       |
| 0.07                       | 41            | Lost Card           |       |
| 0.08                       | 43            | Stolen Card         |       |
| 0.14                       | 14            | Invalid Account     |       |
| 0.29                       | 54            | Expired Card        |       |
| 0.30                       | 92            | Invalid Routing     |       |
| 0.31                       | 12            | Invalid Transaction |       |
| 0.39                       | 15            | No Such Issuer      |       |
| 32.85                      | 08            | Honor With ID       |       |

## AVS Triggers and Response Codes:

| Street Number Trigger | Zip Code Trigger | Response Code | Response Text             | Notes                                                                                                     |
|-----------------------|------------------|---------------|---------------------------|-----------------------------------------------------------------------------------------------------------|
| 8320                  |                  | A             | Address Match             | Tests address only. Please note that Card Associations only verity the street number of a street address. |
|                       | 85284            | Z             | Zip Match                 | Tests Zip Only                                                                                            |
| 8320                  | 85284            | Y             | Exact Match               | Tests Address & Zip                                                                                       |
|                       | M4P1Z2           | Y             | Exact Match               |                                                                                                           |
|                       | M4P1Z3           | NONE          | Approval                  |                                                                                                           |
|                       | M11AA            | Y             | Exact Match               |                                                                                                           |
|                       | EC1A1BB          | Y             | Exact Match               |                                                                                                           |
|                       | 99999            | U             | Ver Unavailable           |                                                                                                           |
|                       | 99998            | G             | Ver Unavailable           |                                                                                                           |
|                       | 999970001        | B             | Address Match             |                                                                                                           |
|                       | 999970002        | C             | Serv Unavailable          |                                                                                                           |
|                       | 999970003        | D             | Exact Match               |                                                                                                           |
|                       | 999970004        | I             | Ver Unavailable           |                                                                                                           |
|                       | 999970005        | M             | Exact Match               |                                                                                                           |
|                       | 999970006        | P             | Zip Match                 |                                                                                                           |
|                       | 999970007        | A             | Address Match             |                                                                                                           |
|                       | 999970008        | Y             | Exact Match               |                                                                                                           |
|                       | 999970009        | S             | Service Supported         |                                                                                                           |
|                       | 999970010        | R             | Issuer System Unavailable |                                                                                                           |

## CVV Values Triggers and Responses:

| CVV2 Request Value Trigger | CVV2 Results Code | Notes                        |
|----------------------------|-------------------|------------------------------|
| 11^999 (VISA)              | M                 |                              |
| 11^998 (MASTERCARD)        | M                 |                              |
| 11^996 (DISCOVER)          | M                 |                              |
| 11^996 (DINERS)            | M                 |                              |
| 11^123 (NON-AMEX)          | N                 | TSYS ISO F39=N7              |
| 10^999 (VISA)              | N/A               |                              |
| 10^998 (MASTERCARD)        | N/A               |                              |
| 10^996 (DISCOVER)          | N/A               |                              |
| 10^996 (DINERS)            | N/A               |                              |
| 11^899 (VISA)              | U                 |                              |
| 11^898 (MASTERCARD)        | U                 |                              |
| 10^123                     | N/A               |                              |
| 01^^^^                     | P                 | CVV2 not provided            |
| 21^^^^                     | P                 | CVV2 is illegible            |
| 91^^^^                     | S                 | CVV2 was not present on card |
| 00^^^^                     | N/A               | CVV2 was not provided        |
| 20^^^^                     | N/A               | CVV2 was illegible           |

## Partial Authorization Test Data:

To test partial authorization please use the below information:

| CARD NUMBER         | CVV | EXP DATE | ENTER AMOUNT | APPROVE AMOUNT |
|---------------------|-----|----------|--------------|----------------|
| 6011 0009 9302 6909 | 996 | 01/26    | 10.10        | 10.00          |
| 5146 3126 2000 0045 | 998 | 01/26    | 11.10        | 5.55           |

## Decline Codes:

| Response Code | Authorization response message | Response definition                                                                             |
|---------------|--------------------------------|-------------------------------------------------------------------------------------------------|
| 00            | APPROVAL                       | Approved and complete                                                                           |
| 01            | CALL                           | Refer to issuer                                                                                 |
| 02            | CALL                           | Refer to issuer-Special condition                                                               |
| 03            | TERM ID ERROR                  | Invalid Merchant ID                                                                             |
| 04            | HOLD-CALL                      | Pick up card (no fraud)                                                                         |
| 05            | DECLINE                        | Do not honor                                                                                    |
| 06            | ERROR                          | General Error                                                                                   |
| 07            | HOLD-CALL                      | Pick up card, special condition (fraud account)                                                 |
| 08            | APPROVAL                       | Honor Mastercard with ID                                                                        |
| 10            | PARTIAL APPROVAL               | Partial approval for the authorized amount returned in Group III                                |
| 11            | APPROVAL                       | VIP approval                                                                                    |
| 12            | INVALID TRANS                  | Invalid Transaction                                                                             |
| 13            | AMOUNT ERROR                   | Invalid Amount                                                                                  |
| 14            | CARD NO. ERROR                 | Invalid card number                                                                             |
| 15            | NO SUCH ISSUER                 | No such issuer                                                                                  |
| 19            | RE ENTER                       | Re-enter transaction                                                                            |
| 21            | NO ACTION TAKEN                | Unable to locate the account number                                                             |
| 25            | NO CARD NUMBER                 | Unable to locate the account number                                                             |
| 28            | NO REPLY                       | File is temporarily unavailable                                                                 |
| 30            | MSG FORMAT ERROR               | Transaction was improperly formatted                                                            |
| 41            | HOLD-CALL                      | Lost card, pick up (fraud account)                                                              |
| 43            | HOLD-CALL                      | Stolen card, pick up (fraud account)                                                            |
| 46            | CLOSED ACCOUNT                 | Closed Account                                                                                  |
| 51            | DECLINE                        | Insufficient funds                                                                              |
| 52            | NO CHECK ACCOUNT               | No checking account                                                                             |
| 53            | NO SAVE ACCOUNT                | No saving account                                                                               |
| 54            | EXPIRED CARD                   | Expired card                                                                                    |
| 55            | WRONG PIN                      | Incorrect PIN                                                                                   |
| 57            | SERV NOT ALLOWED               | Transaction not permitted-Card                                                                  |
| 58            | SERV NOT ALLOWED               | Transaction not permitted-Terminal                                                              |
| 59            | SUSPECTED FRAUD                | Suspected fraud                                                                                 |
| 61            | EXP APPR AMT LIM               | Exceeds approval amount limit                                                                   |
| 62            | DECLINE                        | Invalid service code, restricted                                                                |
| 63            | SEC VIOLATION                  | Security violation                                                                              |
| 65            | EXC W/D FREQ LIM               | Exceeds withdrawal frequency limit                                                              |
| 6P            | VERIF DATA FAILD               | Verification data failed                                                                        |
| 75            | PIN EXCEEDED                   | Allowable number of PIN-entry tries exceeded                                                    |
| 76            | UNSOLIC REVERSAL               | Unable to locate, no match                                                                      |
| 77            | NO ACTION TAKEN                | Inconsistent, reversed or repeat data                                                           |
| 78            | NO ACCOUNT                     | Blocked, first used transaction from new cardholder, and card not properly unblocked            |
| 79            | ALREADY REVERSED               | Already reversed at switch                                                                      |
| 80            | NO IMPACT                      | No financial impact (used in reversal response to decline originals)                            |
| 81            | ENCRYPTION ERROR               | Cryptographic error                                                                             |
| 82            | INCORRECT CVV                  | CVV data is not correct OR offline PIN authentication interrupted                               |
| 83            | CAN’T VERIFY PIN               | Cannot verify PIN                                                                               |
| 85            | CARD OK                        | No reason to decline                                                                            |
| 86            | CAN’T VERIFY PIN               | Cannot verify PIN                                                                               |
| 91            | NO REPLY                       | Issuer or switch unavailable                                                                    |
| 92            | INVALID ROUTING                | Destination not found                                                                           |
| 93            | DECLINE                        | Violation, cannot complete                                                                      |
| 94            | DUPLICATE TRANS                | Unable to location, no match                                                                    |
| 96            | SYSTEM ERROR                   | System malfunction                                                                              |
| A1            | ACTIVATED                      | POS device authentication successful                                                            |
| A2            | NOT ACTIVATED                  | POS device authentication not successful                                                        |
| A3            | DEACTIVATED                    | POS device deactivation successful                                                              |
| B1            | SRCHG NOT ALLOWED              | Surcharge amount not permitted on debit card or EBT food stamps                                 |
| B2            | SRCHRG NOT ALLOWED             | Surcharge amount not supported by debit network                                                 |
| CV            | FAILURE HV                     | Card type verification error                                                                    |
| D3            | SECUR CRYPT FAIL               | Transaction failure due to missing or invalid 3D-Secure cryptogram                              |
| E1            | ENCR NOT CONFIGD               | Encryption is not configured                                                                    |
| E2            | TERM NOT AUTHENT               | Terminal is not authenticated                                                                   |
| E3            | DECRYPT FAILURE                | Data could not be decrypted                                                                     |
| EA            | ACCT LENGTH ERR                | Verification error                                                                              |
| EB            | CHECK DIGIT ERR                | Verification error                                                                              |
| EC            | CID FORMAT ERROR               | Verification error                                                                              |
| H1            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H2            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H4            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H5            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H6            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H7            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H8            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| H9            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| HV            | FAILURE HV                     | Hierarchy Verification Error                                                                    |
| K0            | TOKEN RESPONSE                 | Token request was processed                                                                     |
| K1            | TOKEN NOT CONFIG               | Tokenization is not configured                                                                  |
| K3            | TOKEN FAILURE                  | Data could not be de-tokenized                                                                  |
| M0            | DOM DBT NOT ALWD               | Mastercard: Canada region-issued Domestic Debit Transaction not allowed                         |
| N3            | CASHBACK NOT AVL               | Cash back service not available                                                                 |
| N4            | DECLINE                        | Exceeds issuer withdrawal limit                                                                 |
| N7            | CVV2 MISMATCH                  | CVV2 Value supplied is invalid                                                                  |
| P0            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P1            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P2            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P3            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P4            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P5            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P6            | SERV NOT ALLOWED               | Contact Merchant Services/Technical Support                                                     |
| P7            | MISSING SERIAL NUM             | The terminal has not yet completed the boarding process. The Serial Number has not been set up. |
| Q1            | CARD AUTH FAIL                 | Card authentication failed                                                                      |
| R0            | STOP RECURRING                 | Customer requested stop of all recurring payment                                                |
| R1            | STOP RECURRING                 | Customer requested stop of all recurring payments from specific merchant                        |
| R3            | STOP ALL RECUR                 | All recurring payments have been canceled for the card number in the request                    |
| S0            | INACTIVE CARD                  | The PAN used in the transaction is inactive                                                     |
| S1            | MOD 10 FAIL                    | The Mod-10 check failed.                                                                        |
| S5            | DCLN NO PRE AUTH               | Decline-no preauthorization found                                                               |
| S9            | MAX BALANCE                    | Maximum working balance exceeded                                                                |
| SA            | SHUT DOWN                      | The authorization server is shut down                                                           |
| SB            | INVALID STATUS                 | Invalid card status-status is other than active                                                 |
| SC            | UNKNOWN STORE                  | Unknown dealer/store code-special edit                                                          |
| SD            | TOO MANY RCHRGS                | Maximum number of recharges is exceeded                                                         |
| SE            | ALREADY USED                   | Card was already used                                                                           |
| SF            | NOT MANUAL                     | Manual transactions not allowed                                                                 |
| SH            | TYPE UNKNOWN                   | Transaction type was unknown                                                                    |
| SJ            | INVALID TENDER                 | An invalid tender type was submitted                                                            |
| SM            | MAX REDEMPTS                   | The maximum number of redemptions was exceeded                                                  |
| SP            | MAX APN TRIES                  | The maximum number of PAN tries was exceeded                                                    |
| SR            | ALREADY ISSUED                 | The card was already issued                                                                     |
| SS            | NOT ISSUED                     | The card was not issued                                                                         |
| T0            | APPROVAL                       | Frist check is okay and has been converted                                                      |
| T1            | CANNOT CONVERT                 | The check is okay but cannot be converted. This is a declined transaction                       |
| T2            | INVALID ABA                    | Invalid ABA number, not an ACH participant                                                      |
| T3            | AMOUNT ERROR                   | Amount greater than the limit                                                                   |
| V1            | FAILURE VM                     | Daily threshold exceeded                                                                        |
