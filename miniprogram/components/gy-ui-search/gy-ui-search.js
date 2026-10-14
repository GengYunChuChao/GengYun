Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    value: { type: String, value: '' },
    placeholder: { type: String, value: '搜索' },
    disabled: { type: Boolean, value: false }
  },
  methods: {
    onInput(event) {
      if (this.data.disabled) return;
      this.triggerEvent('input', { value: event.detail.value });
    },
    onConfirm(event) {
      if (this.data.disabled) return;
      this.triggerEvent('confirm', { value: event.detail.value });
    },
    onClear() {
      if (this.data.disabled) return;
      this.triggerEvent('clear', { value: '' });
    }
  }
});
