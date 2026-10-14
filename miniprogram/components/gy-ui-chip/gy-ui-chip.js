Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    label: { type: String, value: '' },
    value: { type: String, value: '' },
    selected: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false }
  },
  methods: {
    onTap() {
      if (this.data.disabled) return;
      this.triggerEvent('select', { value: this.data.value, selected: !this.data.selected });
    }
  }
});
