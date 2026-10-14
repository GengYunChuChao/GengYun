Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    label: { type: String, value: '' },
    variant: { type: String, value: 'secondary' },
    block: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    loading: { type: Boolean, value: false }
  },
  methods: {
    onTap() {
      if (this.data.disabled || this.data.loading) return;
      this.triggerEvent('tap');
    }
  }
});
