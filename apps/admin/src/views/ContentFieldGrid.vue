<script setup>
/**
 * 表单字段网格（资料来源／科普内容／分类编辑共用）。
 *
 * 只用原生控件，不引入组件库；字段描述由各页给（`{key, label, type, options, hint, required, wide}`）。
 * 校验错误按字段就地显示；无法对应到网格字段的错误集中在底部列出，**一条都不吞**。
 */
import { computed } from 'vue';

const props = defineProps({
  fields: { type: Array, required: true },
  form: { type: Object, required: true },
  errors: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['update']);

const keys = computed(() => new Set(props.fields.map((field) => field.key)));
const unmatchedErrors = computed(() => props.errors.filter((error) => !keys.value.has(error.field)));

function errorOf(key) {
  const hit = props.errors.find((error) => error.field === key);
  return hit === undefined ? '' : hit.message;
}
</script>

<template>
  <div class="fields">
    <label v-for="field in fields" :key="field.key" class="field" :class="{ wide: field.wide === true, check: field.type === 'checkbox' }">
      <span class="label">
        {{ field.label }}
        <em v-if="field.required === true">必填</em>
      </span>

      <select
        v-if="field.type === 'select'"
        :value="form[field.key]"
        :disabled="disabled"
        @change="emit('update', field.key, $event.target.value)"
      >
        <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>

      <textarea
        v-else-if="field.type === 'textarea'"
        :value="form[field.key]"
        rows="4"
        :disabled="disabled"
        :placeholder="field.placeholder ?? ''"
        @input="emit('update', field.key, $event.target.value)"
      />

      <input
        v-else-if="field.type === 'checkbox'"
        type="checkbox"
        :checked="form[field.key] === true"
        :disabled="disabled"
        @change="emit('update', field.key, $event.target.checked)"
      />

      <input
        v-else
        :type="field.type ?? 'text'"
        :value="form[field.key]"
        :disabled="disabled"
        :placeholder="field.placeholder ?? ''"
        @input="emit('update', field.key, $event.target.value)"
      />

      <small v-if="field.hint" class="hint">{{ field.hint }}</small>
      <small v-if="errorOf(field.key) !== ''" class="err">{{ errorOf(field.key) }}</small>
    </label>

    <ul v-if="unmatchedErrors.length > 0" class="unmatched">
      <li v-for="error in unmatchedErrors" :key="`${error.field}-${error.message}`">{{ error.field }}：{{ error.message }}</li>
    </ul>
  </div>
</template>

<style scoped>
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.6rem 0.9rem;
}
.field {
  display: grid;
  gap: 0.2rem;
  align-content: start;
}
.field.wide {
  grid-column: 1 / -1;
}
.field.check {
  grid-template-columns: auto 1fr;
  align-items: center;
}
.label {
  font-size: 0.86rem;
  color: #2d3748;
}
.label em {
  margin-left: 0.35rem;
  font-style: normal;
  font-size: 0.72rem;
  color: #c05621;
}
input,
select,
textarea {
  padding: 0.4rem 0.55rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
.field.check input {
  width: 1.1rem;
  height: 1.1rem;
}
.hint {
  color: #4a5568;
  font-size: 0.78rem;
  line-height: 1.5;
}
.err {
  color: #c53030;
  font-size: 0.8rem;
}
.unmatched {
  grid-column: 1 / -1;
  margin: 0;
  padding-left: 1.1rem;
  color: #c53030;
  font-size: 0.82rem;
}
</style>
