odoo.define('pos_cardano.payment', function (require) {
"use strict";

var core = require('web.core');
var rpc = require('web.rpc');
var PaymentInterface = require('point_of_sale.PaymentInterface');

// For string translations
var _t = core._t;

var PaymentCardano = PaymentInterface.extend({
    send_payment_request: function (cid) {
        this._super.apply(this, arguments);
        this._reset_state();
        return this._cardano_pay();
    },
    send_payment_cancel: function (order, cid) {
        this._super.apply(this, arguments);
        // set only if we are polling
        this.was_cancelled = !!this.polling;
        return this._cardano_cancel();
    },
    close: function () {
        this._super.apply(this, arguments);
    },

    // private methods
    _reset_state: function () {
        this.was_cancelled = false;
        this.last_diagnosis_service_id = false;
        this.remaining_polls = 2;
        clearTimeout(this.polling);
    },

    _handle_odoo_connection_failure: function (data) {
        // handle timeout
        var line = this.pos.get_order().selected_paymentline;
        if (line) {
            line.set_payment_status('retry');
        }
        this._show_error(_('Could not connect to the Odoo server, please check your internet connection and try again.'));

        return Promise.reject(data); // prevent subsequent onFullFilled's from being called
    },

    _call_cardano: function (data) {
        var self = this;
        return rpc.query({
            model: 'pos.payment.method',
            method: 'proxy_cardano_request',
            args: [data, this.payment_method.cardano_test_mode, this.payment_method.cardano_wallet_address],
        }, {
            // When a payment terminal is disconnected it takes Cardano
            // a while to return an error (~6s). So wait 10 seconds
            // before concluding Odoo is unreachable.
            timeout: 10000,
            shadow: true,
        }).catch(this._handle_odoo_connection_failure.bind(this));
    },

    _cardano_get_sale_id: function () {
        var config = this.pos.config;
        return _.str.sprintf('%s (ID: %s)', config.display_name, config.id);
    },

    _cardano_common_message_header: function () {
        var config = this.pos.config;
        this.most_recent_service_id = Math.floor(Math.random() * Math.pow(2, 64)).toString(); // random ID to identify request/response pairs
        this.most_recent_service_id = this.most_recent_service_id.substring(0, 10); // max length is 10

        return {
            'ProtocolVersion': '3.0',
            'MessageClass': 'Service',
            'MessageType': 'Request',
            'SaleID': this._cardano_get_sale_id(config),
            'ServiceID': this.most_recent_service_id,
            'POIID': this.payment_method.cardano_terminal_identifier
        };
    },

    _cardano_pay_data: function () {
        var order = this.pos.get_order();
        var config = this.pos.config;
        var line = order.selected_paymentline;
        var data = {
            'SaleToPOIRequest': {
                'MessageHeader': _.extend(this._cardano_common_message_header(), {
                    'MessageCategory': 'Payment',
                }),
                'PaymentRequest': {
                    'SaleData': {
                        'SaleTransactionID': {
                            'TransactionID': order.uid,
                            'TimeStamp': moment().format(), // iso format: '2018-01-10T11:30:15+00:00'
                        }
                    },
                    'PaymentTransaction': {
                        'AmountsReq': {
                            'Currency': this.pos.currency.name,
                            'RequestedAmount': line.amount,
                        }
                    }
                }
            }
        };

        if (config.cardano_ask_customer_for_tip) {
            data.SaleToPOIRequest.PaymentRequest.SaleData.SaleToAcquirerData = "tenderOption=AskGratuity";
        }

        return data;
    },

    _cardano_pay: function () {
        var self = this;

        if (this.pos.get_order().selected_paymentline.amount < 0) {
            this._show_error(_('Cannot process transactions with negative amount.'));
            return Promise.resolve();
        }

        var data = this._cardano_pay_data();
        console.log(data)
        return this._call_cardano(data).then(function (data) {
            return self._cardano_handle_response(data);
        });
    },

    _cardano_cancel: function (ignore_error) {
        console.log('_cardano_cancel')
        var previous_service_id = this.most_recent_service_id;
        var header = _.extend(this._cardano_common_message_header(), {
            'MessageCategory': 'Abort',
        });

        var data = {
            'SaleToPOIRequest': {
                'MessageHeader': header,
                'AbortRequest': {
                    'AbortReason': 'MerchantAbort',
                    'MessageReference': {
                        'MessageCategory': 'Payment',
                        'SaleID': header.SaleID,
                        'ServiceID': previous_service_id,
                    }
                },
            }
        };

        return this._call_cardano(data).then(function (data) {

            // Only valid response is a 200 OK HTTP response which is
            // represented by true.
            if (! ignore_error && data !== true) {
                self._show_error(_('Cancelling the payment failed. Please cancel it manually on the payment terminal.'));
            }
        });
    },

    _convert_receipt_info: function (output_text) {
        return output_text.reduce(function (acc, entry) {
            var params = new URLSearchParams(entry.Text);

            if (params.get('name') && !params.get('value')) {
                return acc + _.str.sprintf('<br/>%s', params.get('name'));
            } else if (params.get('name') && params.get('value')) {
                return acc + _.str.sprintf('<br/>%s: %s', params.get('name'), params.get('value'));
            }

            return acc;
        }, '');
    },

    _poll_for_response: function (resolve, reject) {
        var self = this;
        if (this.was_cancelled) {
            resolve(false);
            return Promise.resolve();
        }

        return rpc.query({
            model: 'pos.payment.method',
            method: 'get_latest_cardano_status',
            args: [this.payment_method.id,
                   this._cardano_get_sale_id(),
                   this.payment_method.cardano_terminal_identifier,
                   this.payment_method.cardano_test_mode,
                   this.payment_method.cardano_wallet_address],
        }, {
            timeout: 5000,
            shadow: true,
        }).catch(function (data) {
            reject();
            return self._handle_odoo_connection_failure(data);
        }).then(function (status) {
            console.log('_poll_for_response');
            console.log(status);
            console.log(self.most_recent_service_id);
            
            var notification = status.latest_response;
            
            var last_diagnosis_service_id = status.last_received_diagnosis_id;
            var order = self.pos.get_order();
            var line = order.selected_paymentline;

            console.log('diagnosis_id: ' + self.last_diagnosis_service_id + ' !=  ' + last_diagnosis_service_id)
            if (self.last_diagnosis_service_id != last_diagnosis_service_id) {
                self.last_diagnosis_service_id = last_diagnosis_service_id;
                self.remaining_polls = 2;
            } else {
                self.remaining_polls--;
            }

            if (notification) {
                console.log('notification: ' + notification.SaleToPOIResponse.MessageHeader.ServiceID);
                console.log('self.most_recent_service_id: ' + self.most_recent_service_id);
            }  
                      
            if (notification && notification.SaleToPOIResponse.MessageHeader.ServiceID == self.most_recent_service_id) {
                var response = notification.SaleToPOIResponse.PaymentResponse.Response;
                
                var additional_response = new URLSearchParams(response.AdditionalResponse);

                if (response.Result == 'Success') {
                    var config = self.pos.config;
                    var payment_response = notification.SaleToPOIResponse.PaymentResponse;
                    var payment_result = payment_response.PaymentResult;
                    //var customer_receipt = payment_response.PaymentReceipt.find(function (receipt) {
                    //    return receipt.DocumentQualifier == 'CustomerReceipt';
                    //});

                    //if (customer_receipt) {
                    //    line.set_receipt_info(self._convert_receipt_info(customer_receipt.OutputContent.OutputText));
                    // }

                    var tip_amount = payment_result.AmountsResp.TipAmount;
                    if (config.cardano_ask_customer_for_tip && tip_amount > 0) {
                        order.set_tip(tip_amount);
                        line.set_amount(payment_result.AmountsResp.AuthorizedAmount);
                    }

                    line.transaction_id = additional_response.get('pspReference');
                    line.card_type = additional_response.get('cardType');
                    resolve(true);
                } else {
                    var message = additional_response.get('message');
                    self._show_error(_.str.sprintf(_t('Message from Cardano: %s'), message));

                    // this means the transaction was cancelled by pressing the cancel button on the device
                    if (message.startsWith('108 ')) {
                        resolve(false);
                    } else {
                        line.set_payment_status('force_done');
                        reject();
                    }
                }
            } else if (self.remaining_polls <= 0) {
                self._show_error(_t('The connection to your payment terminal failed. Please check if it is still connected to the internet.'));
                self._cardano_cancel();
                resolve(false);
            }
        });
    },

    _cardano_handle_response: function (response) {
        var line = this.pos.get_order().selected_paymentline;

        if (response.error && response.error.status_code == 401) {
            this._show_error(_t('Authentication failed. Please check your Cardano credentials.'));
            line.set_payment_status('force_done');
            return Promise.resolve();
        }

        response = response.SaleToPOIRequest;
        if (response && response.EventNotification && response.EventNotification.EventToNotify == 'Reject') {
            console.error('error from Cardano', response);

            var msg = '';
            if (response.EventNotification) {
                var params = new URLSearchParams(response.EventNotification.EventDetails);
                msg = params.get('message');
            }

            this._show_error(_.str.sprintf(_t('An unexpected error occured. Message from Cardano: %s'), msg));
            if (line) {
                line.set_payment_status('force_done');
            }

            return Promise.resolve();
        } else {
            line.set_payment_status('waitingCard');

            // This is not great, the payment screen should be
            // refactored so it calls render_paymentlines whenever a
            // paymentline changes. This way the call to
            // set_payment_status would re-render it automatically.
            this.pos.chrome.gui.current_screen.render_paymentlines();

            var self = this;
            var res = new Promise(function (resolve, reject) {
                // clear previous intervals just in case, otherwise
                // it'll run forever
                clearTimeout(self.polling);

                self.polling = setInterval(function () {
                    self._poll_for_response(resolve, reject);
                }, 3000);
            });

            // make sure to stop polling when we're done
            res.finally(function () {
                self._reset_state();
            });

            return res;
        }
    },

    _show_error: function (msg, title) {
        if (!title) {
            title =  _t('Cardano Error');
        }
        this.pos.gui.show_popup('error',{
            'title': title,
            'body': msg,
        });
    },
});

return PaymentCardano;
});
